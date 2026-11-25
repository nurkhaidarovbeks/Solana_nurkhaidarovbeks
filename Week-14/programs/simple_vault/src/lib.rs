use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

pub mod raydium;
use raydium::*;

declare_id!("EbojNUfh9Jk6dyZaaQAJWofbdnkvdxfQbeAPq6iWoHAu");

pub const DEPOSIT_FEE_BPS: u64 = 100;
pub const BPS_DENOMINATOR: u64 = 10_000;

#[program]
pub mod simple_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.admin = ctx.accounts.admin.key();
        vault.token_mint = ctx.accounts.token_mint.key();
        vault.vault_token_account = ctx.accounts.vault_token_account.key();
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.total_tokens = 0;
        vault.total_shares = 0;
        vault.bump = ctx.bumps.vault_state;
        vault.fee_wallet = ctx.accounts.fee_wallet.key();
        vault.min_deposit = 10u64
            .checked_pow(ctx.accounts.token_mint.decimals as u32)
            .ok_or(VaultError::MathOverflow)?;
        vault.paused = false;

        msg!("Vault initialized for mint: {}", vault.token_mint);
        Ok(())
    }

    pub fn create_user_card(ctx: Context<CreateUserCard>) -> Result<()> {
        let card = &mut ctx.accounts.user_card;
        card.vault = ctx.accounts.vault_state.key();
        card.owner = ctx.accounts.user.key();
        card.bump = ctx.bumps.user_card;

        msg!("User card created for: {}", card.owner);
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        require!(!ctx.accounts.vault_state.paused, VaultError::VaultPaused);
        require!(!ctx.accounts.vault_state.in_market, VaultError::InMarket);
        require!(amount >= ctx.accounts.vault_state.min_deposit, VaultError::DepositTooSmall);

        let vault = &ctx.accounts.vault_state;

        let fee = (amount as u128)
            .checked_mul(DEPOSIT_FEE_BPS as u128)
            .and_then(|v| v.checked_div(BPS_DENOMINATOR as u128))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or(VaultError::MathOverflow)?;
        let net = amount.checked_sub(fee).ok_or(VaultError::MathOverflow)?;

        let shares = if vault.total_shares == 0 || vault.total_tokens == 0 {
            net
        } else {
            (net as u128)
                .checked_mul(vault.total_shares as u128)
                .and_then(|v| v.checked_div(vault.total_tokens as u128))
                .and_then(|v| u64::try_from(v).ok())
                .ok_or(VaultError::MathOverflow)?
        };
        require!(shares > 0, VaultError::SharesTooSmall);

        if fee > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_account.to_account_info(),
                        to: ctx.accounts.fee_wallet.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                fee,
            )?;
        }

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            net,
        )?;

        let token_mint_key = ctx.accounts.vault_state.token_mint;
        let seeds = &[
            b"vault".as_ref(),
            token_mint_key.as_ref(),
            &[ctx.accounts.vault_state.bump],
        ];
        let signer = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.user_share_account.to_account_info(),
                    authority: ctx.accounts.vault_state.to_account_info(),
                },
                signer,
            ),
            shares,
        )?;

        let vault = &mut ctx.accounts.vault_state;
        vault.total_tokens = vault.total_tokens.checked_add(net).ok_or(VaultError::MathOverflow)?;
        vault.total_shares = vault.total_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;

        let card = &mut ctx.accounts.user_card;
        card.deposited = card.deposited.checked_add(net).ok_or(VaultError::MathOverflow)?;
        card.shares = card.shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;

        msg!(
            "Deposit: {} tokens (fee {}) -> {} shares (total_tokens={}, total_shares={})",
            amount, fee, shares, vault.total_tokens, vault.total_shares
        );
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, shares_amount: u64) -> Result<()> {
        withdraw_shares(ctx.accounts, shares_amount)
    }

    pub fn withdraw_all(ctx: Context<Withdraw>) -> Result<()> {
        let shares_amount = ctx.accounts.user_share_account.amount;
        withdraw_shares(ctx.accounts, shares_amount)
    }

    pub fn close_user_card(ctx: Context<CloseUserCard>) -> Result<()> {
        require!(ctx.accounts.user_card.shares == 0, VaultError::CardNotEmpty);
        msg!("User card closed for: {}", ctx.accounts.user.key());
        Ok(())
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        ctx.accounts.vault_state.paused = paused;
        msg!("Vault paused: {}", paused);
        Ok(())
    }

    pub fn add_pair_token(ctx: Context<AddPairToken>) -> Result<()> {
        raydium::add_pair_token(ctx)
    }

    pub fn swap<'a, 'b, 'c: 'info, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, VaultSwap<'info>>,
        amount_in: u64,
        min_amount_out: u64,
        a_to_b: bool,
    ) -> Result<()> {
        raydium::swap(ctx, amount_in, min_amount_out, a_to_b)
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
        raydium::open_position(
            ctx,
            tick_lower_index,
            tick_upper_index,
            tick_array_lower_start_index,
            tick_array_upper_start_index,
            amount_0_max,
            amount_1_max,
            base_0,
        )
    }

    pub fn increase_liquidity<'a, 'b, 'c: 'info, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, VaultPosition<'info>>,
        amount_0_max: u64,
        amount_1_max: u64,
        base_0: bool,
    ) -> Result<()> {
        raydium::increase_liquidity(ctx, amount_0_max, amount_1_max, base_0)
    }

    pub fn collect_fees<'a, 'b, 'c: 'info, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, VaultPosition<'info>>,
    ) -> Result<()> {
        raydium::collect_fees(ctx)
    }

    pub fn close_position<'a, 'b, 'c: 'info, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, VaultPosition<'info>>,
        amount_0_min: u64,
        amount_1_min: u64,
    ) -> Result<()> {
        raydium::close_position(ctx, amount_0_min, amount_1_min)
    }

    pub fn sync_vault(ctx: Context<SyncVault>) -> Result<()> {
        raydium::sync_vault(ctx)
    }
}

fn withdraw_shares(accounts: &mut Withdraw, shares_amount: u64) -> Result<()> {
    require!(shares_amount > 0, VaultError::ZeroAmount);
    require!(!accounts.vault_state.in_market, VaultError::InMarket);

    let vault = &accounts.vault_state;
    require!(vault.total_shares > 0, VaultError::VaultEmpty);

    let tokens_out = (shares_amount as u128)
        .checked_mul(vault.total_tokens as u128)
        .and_then(|v| v.checked_div(vault.total_shares as u128))
        .and_then(|v| u64::try_from(v).ok())
        .ok_or(VaultError::MathOverflow)?;
    require!(tokens_out > 0, VaultError::WithdrawTooSmall);

    token::burn(
        CpiContext::new(
            accounts.token_program.to_account_info(),
            Burn {
                mint: accounts.share_mint.to_account_info(),
                from: accounts.user_share_account.to_account_info(),
                authority: accounts.user.to_account_info(),
            },
        ),
        shares_amount,
    )?;

    let token_mint_key = accounts.vault_state.token_mint;
    let seeds = &[
        b"vault".as_ref(),
        token_mint_key.as_ref(),
        &[accounts.vault_state.bump],
    ];
    let signer = &[&seeds[..]];

    token::transfer(
        CpiContext::new_with_signer(
            accounts.token_program.to_account_info(),
            Transfer {
                from: accounts.vault_token_account.to_account_info(),
                to: accounts.user_token_account.to_account_info(),
                authority: accounts.vault_state.to_account_info(),
            },
            signer,
        ),
        tokens_out,
    )?;

    let vault = &mut accounts.vault_state;
    vault.total_tokens = vault.total_tokens.checked_sub(tokens_out).ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault.total_shares.checked_sub(shares_amount).ok_or(VaultError::MathOverflow)?;

    let card = &mut accounts.user_card;
    card.deposited = card.deposited.saturating_sub(tokens_out);
    card.shares = card.shares.saturating_sub(shares_amount);

    msg!(
        "Withdraw: {} shares -> {} tokens (total_tokens={}, total_shares={})",
        shares_amount, tokens_out, vault.total_tokens, vault.total_shares
    );
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = admin,
        space = VaultState::LEN,
        seeds = [b"vault", token_mint.key().as_ref()],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        init,
        payer = admin,
        token::mint = token_mint,
        token::authority = vault_state,
        seeds = [b"vault_tokens", token_mint.key().as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = vault_state,
        seeds = [b"share_mint", token_mint.key().as_ref()],
        bump,
    )]
    pub share_mint: Account<'info, Mint>,

    pub token_mint: Account<'info, Mint>,

    #[account(token::mint = token_mint)]
    pub fee_wallet: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CreateUserCard<'info> {
    #[account(
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        init,
        payer = user,
        space = UserCard::LEN,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub user_card: Account<'info, UserCard>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump,
    )]
    pub user_card: Account<'info, UserCard>,

    #[account(
        mut,
        seeds = [b"vault_tokens", vault_state.token_mint.as_ref()],
        bump,
        token::mint = vault_state.token_mint,
        token::authority = vault_state,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"share_mint", vault_state.token_mint.as_ref()],
        bump,
        mint::authority = vault_state,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = vault_state.token_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = share_mint,
        token::authority = user,
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    #[account(mut, address = vault_state.fee_wallet @ VaultError::WrongFeeWallet)]
    pub fee_wallet: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump,
    )]
    pub user_card: Account<'info, UserCard>,

    #[account(
        mut,
        seeds = [b"vault_tokens", vault_state.token_mint.as_ref()],
        bump,
        token::mint = vault_state.token_mint,
        token::authority = vault_state,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"share_mint", vault_state.token_mint.as_ref()],
        bump,
        mint::authority = vault_state,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = vault_state.token_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = share_mint,
        token::authority = user,
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseUserCard<'info> {
    #[account(
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        close = user,
        constraint = user_card.owner == user.key() @ VaultError::Unauthorized,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump,
    )]
    pub user_card: Account<'info, UserCard>,

    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,
}

#[account]
#[derive(Default)]
pub struct VaultState {
    pub admin: Pubkey,
    pub token_mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub share_mint: Pubkey,
    pub total_tokens: u64,
    pub total_shares: u64,
    pub bump: u8,
    pub token_mint_b: Pubkey,
    pub vault_token_account_b: Pubkey,
    pub position_nft_mint: Pubkey,
    pub in_market: bool,
    pub fee_wallet: Pubkey,
    pub min_deposit: u64,
    pub paused: bool,
    pub total_fees_a: u64,
    pub total_fees_b: u64,
}

impl VaultState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 1 + 32 + 32 + 32 + 1 + 32 + 8 + 1 + 8 + 8;
}

#[account]
#[derive(Default)]
pub struct UserCard {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub deposited: u64,
    pub shares: u64,
    pub bump: u8,
}

impl UserCard {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Shares would be zero - deposit too small")]
    SharesTooSmall,
    #[msg("Vault is empty")]
    VaultEmpty,
    #[msg("Withdraw amount too small")]
    WithdrawTooSmall,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("User card still has shares")]
    CardNotEmpty,
    #[msg("Deposit is below the minimum")]
    DepositTooSmall,
    #[msg("Vault is paused")]
    VaultPaused,
    #[msg("Wrong fee wallet")]
    WrongFeeWallet,
    #[msg("Unauthorized: only admin can call this")]
    Unauthorized,
    #[msg("Vault funds are in the market: deposit/withdraw paused until sync_vault")]
    InMarket,
    #[msg("Pair token (TOKEN_B) is not set: call add_pair_token")]
    PairNotSet,
    #[msg("Pair token must differ from vault token")]
    SameToken,
    #[msg("Pool does not match vault token pair")]
    WrongPool,
    #[msg("tick_lower must be less than tick_upper")]
    InvalidTickRange,
    #[msg("Position is already open")]
    PositionAlreadyOpen,
    #[msg("No open position")]
    NoOpenPosition,
    #[msg("Cannot sync: position is still open, call close_position first")]
    PositionOpen,
    #[msg("Cannot sync: vault still holds TOKEN_B, swap it back to TOKEN_A first")]
    TokenBNotZero,
    #[msg("Swap amount exceeds 50% of vault TOKEN_A")]
    SwapTooLarge,
}
