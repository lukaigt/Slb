# Solana Jupiter Trading Bot

Automated SOL/USDC trading bot using Jupiter aggregator on Solana mainnet.

## Features

- Trades SOL/USDC pair using Jupiter DEX aggregator
- Simple momentum-based strategy (1% price threshold)
- Configurable trade size and slippage
- 60-second cooldown between trades to prevent spam
- Automatic retry on failed transactions
- Detailed logging with timestamps

## Strategy

- Monitors SOL/USDC price every 10 seconds
- **BUY SOL** when price increases by 1% from reference
- **SELL SOL** when price decreases by 1% from reference
- Trades 20% of available balance per trade
- Updates reference price after each trade

## Requirements

- Node.js >= 18.0.0
- Solana wallet with SOL and/or USDC
- RPC endpoint (mainnet)

## Installation

### Local Setup

```bash
# Clone or download the project
cd solana-jupiter-trading-bot

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings
```

### VPS Setup (Ubuntu/Debian)

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone your project
git clone <your-repo-url>
cd solana-jupiter-trading-bot

# Install dependencies
npm install

# Configure environment
cp .env.example .env
nano .env  # Edit with your settings
```

## Configuration

Edit `.env` file:

| Variable | Description | Default |
|----------|-------------|---------|
| `SOLANA_RPC_URL` | Solana RPC endpoint | `https://api.mainnet-beta.solana.com` |
| `PRIVATE_KEY` | Wallet private key (base58 or JSON array) | Required |
| `SLIPPAGE_BPS` | Slippage tolerance (basis points) | `50` (0.5%) |
| `TRADE_PERCENT` | Balance percentage per trade | `0.2` (20%) |

### Private Key Formats

**Base58 format** (from Phantom):
```
PRIVATE_KEY=4tR5vxN7abc123...
```

**JSON array format** (from Solana CLI):
```
PRIVATE_KEY=[123,45,67,89,12,34,56,78,...]
```

## Running

### Development / Testing
```bash
npm start
```

### Production (VPS with PM2)

```bash
# Install PM2 globally
npm install -g pm2

# Start the bot
pm2 start index.js --name "sol-trading-bot"

# View logs
pm2 logs sol-trading-bot

# Monitor
pm2 monit

# Auto-restart on reboot
pm2 startup
pm2 save
```

### Production (systemd)

Create `/etc/systemd/system/sol-bot.service`:

```ini
[Unit]
Description=Solana Trading Bot
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/solana-jupiter-trading-bot
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
EnvironmentFile=/path/to/solana-jupiter-trading-bot/.env

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable sol-bot
sudo systemctl start sol-bot
sudo journalctl -u sol-bot -f  # View logs
```

## Logs

The bot outputs structured logs:

```
[2024-01-15T10:30:00.000Z] [INFO] SOL/USDC Price: $98.5432
[2024-01-15T10:30:00.100Z] [INFO] Price change from reference: +1.25%
[2024-01-15T10:30:00.200Z] [TRADE] Price increased by 1.25% - triggering BUY
[2024-01-15T10:30:01.500Z] [INFO] Trading 50.00 USDC (20% of 250.00 USDC)
[2024-01-15T10:30:02.000Z] [INFO] Expected to receive: 0.507614 SOL
[2024-01-15T10:30:05.000Z] [INFO] Transaction confirmed: https://solscan.io/tx/...
[2024-01-15T10:30:05.100Z] [TRADE] BUY completed. New reference price: $98.5432
```

## Security Notes

- **Never share your private key**
- Use a dedicated trading wallet with limited funds
- Consider using a hardware wallet for large amounts
- Use a reliable RPC provider for production
- Monitor the bot regularly

## RPC Providers

Free (rate limited):
- `https://api.mainnet-beta.solana.com`

Paid (recommended for production):
- [Helius](https://helius.xyz)
- [QuickNode](https://quicknode.com)
- [Alchemy](https://alchemy.com)
- [Triton](https://triton.one)

## Disclaimer

This bot is for educational purposes. Trading cryptocurrency involves significant risk. Use at your own risk. The authors are not responsible for any financial losses.
