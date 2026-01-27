import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";
const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_DECIMALS = 6;

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || "50", 10);
const TRADE_PERCENT = parseFloat(process.env.TRADE_PERCENT || "0.2");
const PRICE_CHECK_INTERVAL_MS = 10_000;
const TRADE_COOLDOWN_MS = 60_000;
const PRICE_THRESHOLD_PERCENT = 1;

let connection;
let wallet;
let lastReferencePrice = null;
let lastTradeTimestamp = 0;

function log(message, level = "INFO") {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

function parsePrivateKey(privateKeyString) {
  const trimmed = privateKeyString.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed);
    return Uint8Array.from(arr);
  }
  return bs58.decode(trimmed);
}

function loadWallet() {
  const privateKeyEnv = process.env.PRIVATE_KEY;
  if (!privateKeyEnv) {
    throw new Error("PRIVATE_KEY environment variable is not set");
  }
  const secretKey = parsePrivateKey(privateKeyEnv);
  return Keypair.fromSecretKey(secretKey);
}

async function getTokenBalance(mint, owner) {
  if (mint === SOL_MINT) {
    const balance = await connection.getBalance(owner);
    return balance / LAMPORTS_PER_SOL;
  }
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
    mint: new PublicKey(mint),
  });
  if (tokenAccounts.value.length === 0) {
    return 0;
  }
  const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
  return balance || 0;
}

async function getSolPrice() {
  const params = new URLSearchParams({
    inputMint: USDC_MINT,
    outputMint: SOL_MINT,
    amount: String(1_000_000),
    slippageBps: String(SLIPPAGE_BPS),
  });
  const response = await fetch(`${JUPITER_QUOTE_API}?${params}`);
  if (!response.ok) {
    throw new Error(`Jupiter quote API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  const outAmount = parseFloat(data.outAmount) / LAMPORTS_PER_SOL;
  const pricePerSol = 1 / outAmount;
  return pricePerSol;
}

async function getQuote(inputMint, outputMint, amountRaw) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountRaw),
    slippageBps: String(SLIPPAGE_BPS),
  });
  const response = await fetch(`${JUPITER_QUOTE_API}?${params}`);
  if (!response.ok) {
    throw new Error(`Jupiter quote API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function getSwapTransaction(quoteResponse) {
  const response = await fetch(JUPITER_SWAP_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!response.ok) {
    throw new Error(`Jupiter swap API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function executeSwap(swapTransaction, retryCount = 0) {
  const maxRetries = 1;
  try {
    const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      maxRetries: 2,
    });
    log(`Transaction sent: ${txid}`);
    const latestBlockHash = await connection.getLatestBlockhash();
    const confirmation = await connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: txid,
    });
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    log(`Transaction confirmed: https://solscan.io/tx/${txid}`);
    return txid;
  } catch (error) {
    if (retryCount < maxRetries) {
      log(`Transaction failed, retrying (${retryCount + 1}/${maxRetries}): ${error.message}`, "WARN");
      await new Promise((r) => setTimeout(r, 2000));
      return executeSwap(swapTransaction, retryCount + 1);
    }
    throw error;
  }
}

async function executeBuy() {
  log("Executing BUY: USDC -> SOL");
  const usdcBalance = await getTokenBalance(USDC_MINT, wallet.publicKey);
  if (usdcBalance < 1) {
    log("Insufficient USDC balance to buy SOL", "WARN");
    return null;
  }
  const tradeAmount = usdcBalance * TRADE_PERCENT;
  const amountRaw = Math.floor(tradeAmount * Math.pow(10, USDC_DECIMALS));
  log(`Trading ${tradeAmount.toFixed(2)} USDC (${TRADE_PERCENT * 100}% of ${usdcBalance.toFixed(2)} USDC)`);
  const quote = await getQuote(USDC_MINT, SOL_MINT, amountRaw);
  const expectedSol = parseFloat(quote.outAmount) / LAMPORTS_PER_SOL;
  log(`Expected to receive: ${expectedSol.toFixed(6)} SOL`);
  const { swapTransaction } = await getSwapTransaction(quote);
  const txid = await executeSwap(swapTransaction);
  return txid;
}

async function executeSell() {
  log("Executing SELL: SOL -> USDC");
  const solBalance = await getTokenBalance(SOL_MINT, wallet.publicKey);
  const reserveForFees = 0.01;
  const availableSol = solBalance - reserveForFees;
  if (availableSol < 0.01) {
    log("Insufficient SOL balance to sell (need to reserve for fees)", "WARN");
    return null;
  }
  const tradeAmount = availableSol * TRADE_PERCENT;
  const amountRaw = Math.floor(tradeAmount * LAMPORTS_PER_SOL);
  log(`Trading ${tradeAmount.toFixed(6)} SOL (${TRADE_PERCENT * 100}% of ${availableSol.toFixed(6)} available SOL)`);
  const quote = await getQuote(SOL_MINT, USDC_MINT, amountRaw);
  const expectedUsdc = parseFloat(quote.outAmount) / Math.pow(10, USDC_DECIMALS);
  log(`Expected to receive: ${expectedUsdc.toFixed(2)} USDC`);
  const { swapTransaction } = await getSwapTransaction(quote);
  const txid = await executeSwap(swapTransaction);
  return txid;
}

function canTrade() {
  const now = Date.now();
  const timeSinceLastTrade = now - lastTradeTimestamp;
  if (timeSinceLastTrade < TRADE_COOLDOWN_MS) {
    const remainingCooldown = Math.ceil((TRADE_COOLDOWN_MS - timeSinceLastTrade) / 1000);
    log(`Trade cooldown active. ${remainingCooldown}s remaining.`);
    return false;
  }
  return true;
}

async function checkAndTrade() {
  try {
    const currentPrice = await getSolPrice();
    log(`SOL/USDC Price: $${currentPrice.toFixed(4)}`);
    if (lastReferencePrice === null) {
      lastReferencePrice = currentPrice;
      log(`Initial reference price set: $${lastReferencePrice.toFixed(4)}`);
      return;
    }
    const priceChange = ((currentPrice - lastReferencePrice) / lastReferencePrice) * 100;
    log(`Price change from reference: ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%`);
    if (!canTrade()) {
      return;
    }
    if (priceChange >= PRICE_THRESHOLD_PERCENT) {
      log(`Price increased by ${priceChange.toFixed(2)}% - triggering BUY`, "TRADE");
      try {
        const txid = await executeBuy();
        if (txid) {
          lastTradeTimestamp = Date.now();
          lastReferencePrice = currentPrice;
          log(`BUY completed. New reference price: $${currentPrice.toFixed(4)}`, "TRADE");
        }
      } catch (error) {
        log(`BUY failed: ${error.message}`, "ERROR");
      }
    } else if (priceChange <= -PRICE_THRESHOLD_PERCENT) {
      log(`Price decreased by ${Math.abs(priceChange).toFixed(2)}% - triggering SELL`, "TRADE");
      try {
        const txid = await executeSell();
        if (txid) {
          lastTradeTimestamp = Date.now();
          lastReferencePrice = currentPrice;
          log(`SELL completed. New reference price: $${currentPrice.toFixed(4)}`, "TRADE");
        }
      } catch (error) {
        log(`SELL failed: ${error.message}`, "ERROR");
      }
    }
  } catch (error) {
    log(`Error in price check: ${error.message}`, "ERROR");
  }
}

async function displayBalances() {
  const solBalance = await getTokenBalance(SOL_MINT, wallet.publicKey);
  const usdcBalance = await getTokenBalance(USDC_MINT, wallet.publicKey);
  log(`Wallet: ${wallet.publicKey.toString()}`);
  log(`SOL Balance: ${solBalance.toFixed(6)} SOL`);
  log(`USDC Balance: ${usdcBalance.toFixed(2)} USDC`);
}

async function main() {
  log("=".repeat(60));
  log("Solana Jupiter Trading Bot Starting");
  log("=".repeat(60));
  connection = new Connection(RPC_URL, "confirmed");
  log(`Connected to RPC: ${RPC_URL}`);
  wallet = loadWallet();
  log(`Wallet loaded: ${wallet.publicKey.toString()}`);
  log(`Slippage: ${SLIPPAGE_BPS} bps`);
  log(`Trade percent: ${TRADE_PERCENT * 100}%`);
  log(`Price check interval: ${PRICE_CHECK_INTERVAL_MS / 1000}s`);
  log(`Trade cooldown: ${TRADE_COOLDOWN_MS / 1000}s`);
  log(`Price threshold: ${PRICE_THRESHOLD_PERCENT}%`);
  log("=".repeat(60));
  await displayBalances();
  log("=".repeat(60));
  log("Starting price monitoring loop...");
  await checkAndTrade();
  setInterval(checkAndTrade, PRICE_CHECK_INTERVAL_MS);
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`, "ERROR");
  console.error(error);
  process.exit(1);
});
