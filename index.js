import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from "@solana/web3.js";
import { parsePriceData } from "@pythnetwork/client";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PYTH_SOL_USD_PRICE_ACCOUNT = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";
const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_DECIMALS = 6;
const PYTH_STALENESS_THRESHOLD_SECONDS = 60;
const PYTH_MAX_CONFIDENCE_RATIO = 0.05;

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || "50", 10);
const TRADE_PERCENT = parseFloat(process.env.TRADE_PERCENT || "0.2");
const BUY_THRESHOLD = parseFloat(process.env.BUY_THRESHOLD || "1");
const SELL_THRESHOLD = parseFloat(process.env.SELL_THRESHOLD || "1");
const COOLDOWN_SECONDS = parseInt(process.env.COOLDOWN_SECONDS || "60", 10);
const COMMITMENT = process.env.COMMITMENT || "confirmed";
const PRICE_CHECK_INTERVAL_MS = 15_000;

let connection;
let wallet;
let lastReferencePrice = null;
let lastTradeTimestamp = 0;

function log(message, level = "INFO") {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

function validateEnvVars() {
  const required = ["SOLANA_RPC_URL", "PRIVATE_KEY"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
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

async function getSolPriceUSD() {
  const accountInfo = await connection.getAccountInfo(PYTH_SOL_USD_PRICE_ACCOUNT);
  if (!accountInfo || !accountInfo.data) {
    throw new Error("Pyth price account not found or empty");
  }
  const priceData = parsePriceData(accountInfo.data);
  if (!priceData.price || priceData.price === 0) {
    log("Pyth price rejected: price is zero or undefined", "WARN");
    throw new Error("Invalid Pyth price: zero or undefined");
  }
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const publishTime = Number(priceData.publishTime || priceData.timestamp || 0);
  const priceAge = currentTimestamp - publishTime;
  if (priceAge > PYTH_STALENESS_THRESHOLD_SECONDS) {
    log(`Pyth price rejected: stale (${priceAge}s old, max ${PYTH_STALENESS_THRESHOLD_SECONDS}s)`, "WARN");
    throw new Error(`Pyth price is stale: ${priceAge} seconds old`);
  }
  const price = priceData.price;
  const confidence = priceData.confidence || 0;
  const confidenceRatio = price > 0 ? confidence / price : 1;
  if (confidenceRatio > PYTH_MAX_CONFIDENCE_RATIO) {
    log(`Pyth price rejected: confidence too wide (${(confidenceRatio * 100).toFixed(2)}% > ${PYTH_MAX_CONFIDENCE_RATIO * 100}%)`, "WARN");
    throw new Error(`Pyth confidence interval too wide: ${(confidenceRatio * 100).toFixed(2)}%`);
  }
  log(`Pyth SOL/USD: $${price.toFixed(4)} (conf: ±$${confidence.toFixed(4)}, age: ${priceAge}s)`, "PYTH");
  return price;
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
    const errorText = await response.text();
    throw new Error(`Jupiter quote API error: ${response.status} ${response.statusText} - ${errorText}`);
  }
  const quoteResponse = await response.json();
  if (!quoteResponse || !quoteResponse.outAmount || !quoteResponse.routePlan) {
    throw new Error("Invalid quote response: no routes available for this swap");
  }
  return quoteResponse;
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
    const errorText = await response.text();
    throw new Error(`Jupiter swap API error: ${response.status} ${response.statusText} - ${errorText}`);
  }
  const swapResponse = await response.json();
  if (!swapResponse || !swapResponse.swapTransaction) {
    throw new Error("Invalid swap response: no transaction returned");
  }
  return swapResponse;
}

async function executeSwap(swapResponse, retryCount = 0) {
  const maxRetries = 1;
  try {
    const { swapTransaction, lastValidBlockHeight } = swapResponse;
    const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);
    const blockhash = transaction.message.recentBlockhash;
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      maxRetries: 2,
    });
    log(`Transaction sent: ${txid}`);
    const blockHeight = lastValidBlockHeight || (await connection.getLatestBlockhash()).lastValidBlockHeight;
    const confirmation = await connection.confirmTransaction({
      blockhash,
      lastValidBlockHeight: blockHeight,
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
      return executeSwap(swapResponse, retryCount + 1);
    }
    throw error;
  }
}

async function executeBuy() {
  log("Executing BUY: USDC -> SOL");
  const usdcBalance = await getTokenBalance(USDC_MINT, wallet.publicKey);
  if (usdcBalance < 0.1) {
    log("Insufficient USDC balance to buy SOL", "WARN");
    return null;
  }
  const tradeAmount = usdcBalance * TRADE_PERCENT;
  const amountRaw = Math.floor(tradeAmount * Math.pow(10, USDC_DECIMALS));
  log(`Trading ${tradeAmount.toFixed(2)} USDC (${TRADE_PERCENT * 100}% of ${usdcBalance.toFixed(2)} USDC)`);
  const quote = await getQuote(USDC_MINT, SOL_MINT, amountRaw);
  const expectedSol = parseFloat(quote.outAmount) / LAMPORTS_PER_SOL;
  log(`Expected to receive: ${expectedSol.toFixed(6)} SOL`);
  const swapResponse = await getSwapTransaction(quote);
  const txid = await executeSwap(swapResponse);
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
  const swapResponse = await getSwapTransaction(quote);
  const txid = await executeSwap(swapResponse);
  return txid;
}

function canTrade() {
  const now = Date.now();
  const cooldownMs = COOLDOWN_SECONDS * 1000;
  const timeSinceLastTrade = now - lastTradeTimestamp;
  if (timeSinceLastTrade < cooldownMs) {
    const remainingCooldown = Math.ceil((cooldownMs - timeSinceLastTrade) / 1000);
    log(`Trade cooldown active. ${remainingCooldown}s remaining.`);
    return false;
  }
  return true;
}

async function checkAndTrade() {
  try {
    const currentPrice = await getSolPriceUSD();
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
    if (priceChange >= BUY_THRESHOLD) {
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
    } else if (priceChange <= -SELL_THRESHOLD) {
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
    log(`Price check skipped: ${error.message}`, "WARN");
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
  validateEnvVars();
  connection = new Connection(RPC_URL, COMMITMENT);
  log(`Connected to RPC: ${RPC_URL}`);
  log(`Commitment: ${COMMITMENT}`);
  wallet = loadWallet();
  log(`Wallet loaded: ${wallet.publicKey.toString()}`);
  log(`Price source: Pyth Network (on-chain)`);
  log(`Pyth SOL/USD account: ${PYTH_SOL_USD_PRICE_ACCOUNT.toString()}`);
  log(`Slippage: ${SLIPPAGE_BPS} bps`);
  log(`Trade percent: ${TRADE_PERCENT * 100}%`);
  log(`Buy threshold: +${BUY_THRESHOLD}%`);
  log(`Sell threshold: -${SELL_THRESHOLD}%`);
  log(`Price check interval: ${PRICE_CHECK_INTERVAL_MS / 1000}s`);
  log(`Trade cooldown: ${COOLDOWN_SECONDS}s`);
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
