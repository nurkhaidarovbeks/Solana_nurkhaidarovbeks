use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::memo::Memo;
use anchor_spl::token::{self, Approve, Mint, Revoke, Token, TokenAccount};
use anchor_spl::token_2022::Token2022;
use raydium_clmm_cpi::{
    cpi,
    states::{PersonalPositionState, PoolState},
};

use crate::{VaultError, VaultState};

pub const MAX_SWAP_BPS: u64 = 5_000;

macro_rules! vault_signer {
    ($signer:ident, $vault:expr) => {
        let mint = $vault.token_mint;
        let bump = [$vault.bump];
        let seeds: &[&[u8]] = &[b"vault", mint.as_ref(), &bump];
        let $signer: &[&[&[u8]]] = &[seeds];
    };
}

fn check_pool(vault: &VaultState, pool: &PoolState) -> Result<()> {
    require!(vault.token_mint_b != Pubkey::default(), VaultError::PairNotSet);
    let pair_ok = (pool.token_mint_0 == vault.token_mint && pool.token_mint_1 == vault.token_mint_b)
        || (pool.token_mint_0 == vault.token_mint_b && pool.token_mint_1 == vault.token_mint);
    require!(pair_ok, VaultError::WrongPool);
    Ok(())
}

#[derive(Accounts)]
pub struct AddPairToken<'info> {
    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    pub token_mint_b: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        token::mint = token_mint_b,
        token::authority = vault_state,
        seeds = [b"vault_tokens_b", vault_state.token_mint.as_ref()],
        bump,
    )]
    pub vault_token_account_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn add_pair_token(ctx: Context<AddPairToken>) -> Result<()> {
    let vault = &mut ctx.accounts.vault_state;
    require!(
        ctx.accounts.token_mint_b.key() != vault.token_mint,
        VaultError::SameToken
    );
    vault.token_mint_b = ctx.accounts.token_mint_b.key();
    vault.vault_token_account_b = ctx.accounts.vault_token_account_b.key();

    msg!("Pair token added: {}", vault.token_mint_b);
    Ok(())
}

#[derive(Accounts)]
pub struct VaultSwap<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut, address = vault_state.vault_token_account)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = vault_state.vault_token_account_b @ VaultError::PairNotSet)]
    pub vault_token_account_b: Box<Account<'info, TokenAccount>>,

    /// CHECK:
    pub amm_config: UncheckedAccount<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// CHECK:
    #[account(mut)]
    pub input_vault: UncheckedAccount<'info>,

    /// CHECK:
    #[account(mut)]
    pub output_vault: UncheckedAccount<'info>,

    /// CHECK:
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    /// CHECK:
    pub input_vault_mint: UncheckedAccount<'info>,

    /// CHECK:
    pub output_vault_mint: UncheckedAccount<'info>,

    /// CHECK:
    #[account(address = raydium_clmm_cpi::id())]
    pub clmm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub memo_program: Program<'info, Memo>,
}

pub fn swap<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, VaultSwap<'info>>,
    amount_in: u64,
    min_amount_out: u64,
    a_to_b: bool,
) -> Result<()> {
    let amount_in = if amount_in == u64::MAX {
        if a_to_b {
            ctx.accounts.vault_token_account.amount
        } else {
            ctx.accounts.vault_token_account_b.amount
        }
    } else {
        amount_in
    };
    require!(amount_in > 0, VaultError::ZeroAmount);

    if a_to_b {
        let max_in = (ctx.accounts.vault_token_account.amount as u128)
            .checked_mul(MAX_SWAP_BPS as u128)
            .and_then(|v| v.checked_div(crate::BPS_DENOMINATOR as u128))
            .ok_or(VaultError::MathOverflow)?;
        require!((amount_in as u128) <= max_in, VaultError::SwapTooLarge);
    }

    let vault = &ctx.accounts.vault_state;
    let (input_mint, output_mint) = if a_to_b {
        (vault.token_mint, vault.token_mint_b)
    } else {
        (vault.token_mint_b, vault.token_mint)
    };

    {
        let pool = ctx.accounts.pool_state.load()?;
        check_pool(vault, &pool)?;
        let pool_vault_of = |mint: Pubkey| {
            if mint == pool.token_mint_0 {
                pool.token_vault_0
            } else {
                pool.token_vault_1
            }
        };
        require_keys_eq!(ctx.accounts.input_vault.key(), pool_vault_of(input_mint), VaultError::WrongPool);
        require_keys_eq!(ctx.accounts.output_vault.key(), pool_vault_of(output_mint), VaultError::WrongPool);
    }

    let (input_account, output_account) = if a_to_b {
        (ctx.accounts.vault_token_account.to_account_info(), ctx.accounts.vault_token_account_b.to_account_info())
    } else {
        (ctx.accounts.vault_token_account_b.to_account_info(), ctx.accounts.vault_token_account.to_account_info())
    };

    let cpi_accounts = cpi::accounts::SwapSingleV2 {
        payer: ctx.accounts.vault_state.to_account_info(),
        amm_config: ctx.accounts.amm_config.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        input_token_account: input_account,
        output_token_account: output_account,
        input_vault: ctx.accounts.input_vault.to_account_info(),
        output_vault: ctx.accounts.output_vault.to_account_info(),
        observation_state: ctx.accounts.observation_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
        memo_program: ctx.accounts.memo_program.to_account_info(),
        input_vault_mint: ctx.accounts.input_vault_mint.to_account_info(),
        output_vault_mint: ctx.accounts.output_vault_mint.to_account_info(),
    };
    vault_signer!(signer, ctx.accounts.vault_state);
    let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.clmm_program.to_account_info(), cpi_accounts, signer)
        .with_remaining_accounts(ctx.remaining_accounts.to_vec());

    cpi::swap_v2(cpi_ctx, amount_in, min_amount_out, 0, true)?;

    ctx.accounts.vault_state.in_market = true;

    msg!("Swap: {} in (a_to_b={}), min_out={}", amount_in, a_to_b, min_amount_out);
    Ok(())
}

#[derive(Accounts)]
pub struct VaultOpenPosition<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut, address = vault_state.vault_token_account)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = vault_state.vault_token_account_b @ VaultError::PairNotSet)]
    pub vault_token_account_b: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    #[account(mut)]
    pub position_nft_mint: Signer<'info>,

    /// CHECK:
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,

    /// CHECK:
    #[account(mut)]
    pub personal_position: UncheckedAccount<'info>,

    /// CHECK:
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,

    /// CHECK:
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,

    /// CHECK:
    #[account(mut)]
    pub token_vault_0: UncheckedAccount<'info>,

    /// CHECK:
    #[account(mut)]
    pub token_vault_1: UncheckedAccount<'info>,

    /// CHECK:
    pub vault_0_mint: UncheckedAccount<'info>,

    /// CHECK:
    pub vault_1_mint: UncheckedAccount<'info>,

    /// CHECK:
    #[account(address = raydium_clmm_cpi::id())]
    pub clmm_program: UncheckedAccount<'info>,

    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program_2022: Program<'info, Token2022>,
}

pub fn open_position<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, VaultOpenPosition<'info>>,
    tick_lower_index: i32,
    tick_upper_index: i32,
    tick_array_lower_start_index: i32,
    tick_array_upper_start_index: i32,
    amount_0_max: u64,
    amount_1_max: u64,
    base_0: bool,
) -> Result<()> {
    require!(tick_lower_index < tick_upper_index, VaultError::InvalidTickRange);
    require!(amount_0_max > 0 || amount_1_max > 0, VaultError::ZeroAmount);

    let vault = &ctx.accounts.vault_state;
    require!(vault.position_nft_mint == Pubkey::default(), VaultError::PositionAlreadyOpen);

    let a_is_token_0 = {
        let pool = ctx.accounts.pool_state.load()?;
        check_pool(vault, &pool)?;
        pool.token_mint_0 == vault.token_mint
    };
    let (account_0, account_1) = if a_is_token_0 {
        (&ctx.accounts.vault_token_account, &ctx.accounts.vault_token_account_b)
    } else {
        (&ctx.accounts.vault_token_account_b, &ctx.accounts.vault_token_account)
    };

    vault_signer!(signer, ctx.accounts.vault_state);
    for (account, amount) in [(account_0, amount_0_max), (account_1, amount_1_max)] {
        token::approve(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Approve {
                    to: account.to_account_info(),
                    delegate: ctx.accounts.admin.to_account_info(),
                    authority: ctx.accounts.vault_state.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
    }

    let cpi_accounts = cpi::accounts::OpenPositionWithToken22Nft {
        payer: ctx.accounts.admin.to_account_info(),
        position_nft_owner: ctx.accounts.vault_state.to_account_info(),
        position_nft_mint: ctx.accounts.position_nft_mint.to_account_info(),
        position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        protocol_position: ctx.accounts.personal_position.to_account_info(),
        tick_array_lower: ctx.accounts.tick_array_lower.to_account_info(),
        tick_array_upper: ctx.accounts.tick_array_upper.to_account_info(),
        personal_position: ctx.accounts.personal_position.to_account_info(),
        token_account_0: account_0.to_account_info(),
        token_account_1: account_1.to_account_info(),
        token_vault_0: ctx.accounts.token_vault_0.to_account_info(),
        token_vault_1: ctx.accounts.token_vault_1.to_account_info(),
        rent: ctx.accounts.rent.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
        token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
        vault_0_mint: ctx.accounts.vault_0_mint.to_account_info(),
        vault_1_mint: ctx.accounts.vault_1_mint.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.clmm_program.to_account_info(), cpi_accounts)
        .with_remaining_accounts(ctx.remaining_accounts.to_vec());

    cpi::open_position_with_token22_nft(
        cpi_ctx,
        tick_lower_index,
        tick_upper_index,
        tick_array_lower_start_index,
        tick_array_upper_start_index,
        0,
        amount_0_max,
        amount_1_max,
        false,
        Some(base_0),
    )?;

    for account in [account_0, account_1] {
        token::revoke(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Revoke {
                source: account.to_account_info(),
                authority: ctx.accounts.vault_state.to_account_info(),
            },
            signer,
        ))?;
    }

    let vault = &mut ctx.accounts.vault_state;
    vault.position_nft_mint = ctx.accounts.position_nft_mint.key();
    vault.in_market = true;

    msg!(
        "Position opened: ticks [{}, {}], nft={}",
        tick_lower_index,
        tick_upper_index,
        vault.position_nft_mint
    );
    Ok(())
}

#[derive(Accounts)]
pub struct VaultPosition<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut, address = vault_state.vault_token_account)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = vault_state.vault_token_account_b @ VaultError::PairNotSet)]
    pub vault_token_account_b: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// CHECK:
    #[account(mut, address = vault_state.position_nft_mint @ VaultError::NoOpenPosition)]
    pub position_nft_mint: UncheckedAccount<'info>,

    /// CHECK:
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = personal_position.pool_id == pool_state.key() @ VaultError::WrongPool,
        constraint = personal_position.nft_mint == vault_state.position_nft_mint @ VaultError::NoOpenPosition,
    )]
    pub personal_position: Box<Account<'info, PersonalPositionState>>,

    /// CHECK:
    #[account(mut)]
    pub token_vault_0: UncheckedAccount<'info>,

    /// CHECK:
    #[account(mut)]
    pub token_vault_1: UncheckedAccount<'info>,

    /// CHECK:
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,

    /// CHECK:
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,

    /// CHECK:
    pub vault_0_mint: UncheckedAccount<'info>,

    /// CHECK:
    pub vault_1_mint: UncheckedAccount<'info>,

    /// CHECK:
    #[account(address = raydium_clmm_cpi::id())]
    pub clmm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub memo_program: Program<'info, Memo>,
    pub system_program: Program<'info, System>,
}

fn decrease_liquidity<'info>(
    accounts: &VaultPosition<'info>,
    remaining: &[AccountInfo<'info>],
    liquidity: u128,
    amount_0_min: u64,
    amount_1_min: u64,
) -> Result<()> {
    let a_is_token_0 = {
        let pool = accounts.pool_state.load()?;
        check_pool(&accounts.vault_state, &pool)?;
        pool.token_mint_0 == accounts.vault_state.token_mint
    };
    let (recipient_0, recipient_1) = if a_is_token_0 {
        (accounts.vault_token_account.to_account_info(), accounts.vault_token_account_b.to_account_info())
    } else {
        (accounts.vault_token_account_b.to_account_info(), accounts.vault_token_account.to_account_info())
    };

    let cpi_accounts = cpi::accounts::DecreaseLiquidityV2 {
        nft_owner: accounts.vault_state.to_account_info(),
        nft_account: accounts.position_nft_account.to_account_info(),
        personal_position: accounts.personal_position.to_account_info(),
        pool_state: accounts.pool_state.to_account_info(),
        protocol_position: accounts.personal_position.to_account_info(),
        token_vault_0: accounts.token_vault_0.to_account_info(),
        token_vault_1: accounts.token_vault_1.to_account_info(),
        tick_array_lower: accounts.tick_array_lower.to_account_info(),
        tick_array_upper: accounts.tick_array_upper.to_account_info(),
        recipient_token_account_0: recipient_0,
        recipient_token_account_1: recipient_1,
        token_program: accounts.token_program.to_account_info(),
        token_program_2022: accounts.token_program_2022.to_account_info(),
        memo_program: accounts.memo_program.to_account_info(),
        vault_0_mint: accounts.vault_0_mint.to_account_info(),
        vault_1_mint: accounts.vault_1_mint.to_account_info(),
    };
    vault_signer!(signer, accounts.vault_state);
    let cpi_ctx = CpiContext::new_with_signer(accounts.clmm_program.to_account_info(), cpi_accounts, signer)
        .with_remaining_accounts(remaining.to_vec());

    cpi::decrease_liquidity_v2(cpi_ctx, liquidity, amount_0_min, amount_1_min)
}

pub fn collect_fees<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, VaultPosition<'info>>,
) -> Result<()> {
    decrease_liquidity(&ctx.accounts, ctx.remaining_accounts, 0, 0, 0)?;
    msg!("Fees collected");
    Ok(())
}

pub fn close_position<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, VaultPosition<'info>>,
    amount_0_min: u64,
    amount_1_min: u64,
) -> Result<()> {
    let liquidity = ctx.accounts.personal_position.liquidity;
    decrease_liquidity(&ctx.accounts, ctx.remaining_accounts, liquidity, amount_0_min, amount_1_min)?;

    let close_accounts = cpi::accounts::ClosePosition {
        nft_owner: ctx.accounts.vault_state.to_account_info(),
        position_nft_mint: ctx.accounts.position_nft_mint.to_account_info(),
        position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
        personal_position: ctx.accounts.personal_position.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        token_program: ctx.accounts.token_program_2022.to_account_info(),
    };
    vault_signer!(signer, ctx.accounts.vault_state);
    cpi::close_position(CpiContext::new_with_signer(
        ctx.accounts.clmm_program.to_account_info(),
        close_accounts,
        signer,
    ))?;

    ctx.accounts.vault_state.position_nft_mint = Pubkey::default();

    let vault_info = ctx.accounts.vault_state.to_account_info();
    let min_balance = Rent::get()?.minimum_balance(vault_info.data_len());
    let extra = vault_info.lamports().saturating_sub(min_balance);
    if extra > 0 {
        **vault_info.try_borrow_mut_lamports()? -= extra;
        **ctx.accounts.admin.to_account_info().try_borrow_mut_lamports()? += extra;
    }

    msg!("Position closed: liquidity={}, rent returned to admin={}", liquidity, extra);
    Ok(())
}

#[derive(Accounts)]
pub struct SyncVault<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(address = vault_state.vault_token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(address = vault_state.vault_token_account_b @ VaultError::PairNotSet)]
    pub vault_token_account_b: Account<'info, TokenAccount>,
}

pub fn sync_vault(ctx: Context<SyncVault>) -> Result<()> {
    let vault = &mut ctx.accounts.vault_state;
    require!(vault.position_nft_mint == Pubkey::default(), VaultError::PositionOpen);
    require!(ctx.accounts.vault_token_account_b.amount == 0, VaultError::TokenBNotZero);

    let before = vault.total_tokens;
    vault.total_tokens = ctx.accounts.vault_token_account.amount;
    vault.in_market = false;

    msg!("Vault synced: total_tokens {} -> {}", before, vault.total_tokens);
    Ok(())
}
