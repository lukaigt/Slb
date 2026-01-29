import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";
import WebSocket from "ws";

dotenv.config();

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Corrected v6 endpoints
const JUPITER_QUOTE_API = "https://api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_API = "https://api.jup.ag/swap/v1/swap";

const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_DECIMALS = 6;
const PRICE_CHECK_INTERVAL_MS = 15_000;
const KRAKEN_WS_URL = "wss://ws.kraken.com";

const RPC_URL = process.env.SOLANA_RPC_URL;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || "50", 10);
const TRADE_PERCENT = parseFloat(process.env.TRADE_PERCENT || "0.2");
const BUY_THRESHOLD = parseFloat(process.env.BUY_THRESHOLD || "1");
const SELL_THRESHOLD = parseFloat(process.env.SELL_THRESHOLD || "1");
const COOLDOWN_SECONDS = parseInt(process.env.COOLDOWN_SECONDS || "60", 10);
const COMMITMENT = process.env.COMMITMENT || "confirmed";

let connection;
let wallet;
let lastReferencePrice = null;
let lastTradeTimestamp = 0;
let lastTradeType = "NONE"; // Track if we last BOUGHT or SOLD
let currentKrakenPrice = null;
let krakenWs = null;
let wsReconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 5000;

function log(message, level = "INFO") {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

function validateEnvVars() {
  const required = ["SOLANA_RPC_URL", "PRIVATE_KEY", "JUPITER_API_KEY"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    log(`Missing required environment variables: ${missing.join(", ")}`, "ERROR");
    process.exit(1);
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
  const secretKey = parsePrivateKey(privateKeyEnv);
  return Keypair.fromSecretKey(secretKey);
}

function connectKrakenWebSocket() {
  return new Promise((resolve) => {
    log("Connecting to Kraken WebSocket...");
    
    krakenWs = new WebSocket(KRAKEN_WS_URL);

    krakenWs.on("open", () => {
      log("Kraken WebSocket connected");
      wsReconnectAttempts = 0;
      
      const subscribeMsg = {
        event: "subscribe",
        pair: ["SOL/USD"],
        subscription: { name: "ticker" }
      };
      krakenWs.send(JSON.stringify(subscribeMsg));
      log("Subscribed to SOL/USD ticker");
    });

    krakenWs.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (Array.isArray(message) && message.length >= 4) {
          const tickerData = message[1];
          if (tickerData && tickerData.c && Array.isArray(tickerData.c)) {
            const lastTradePrice = parseFloat(tickerData.c[0]);
            if (!isNaN(lastTradePrice) && lastTradePrice > 0) {
              currentKrakenPrice = lastTradePrice;
              // Reduced logging frequency for price
              if (Math.random() < 0.1) {
                log(`SOL/USD Price (Kraken WS): ${lastTradePrice.toFixed(4)}`);
              }
              
              if (!resolve.resolved) {
                resolve.resolved = true;
                resolve();
              }
            }
          }
        }
      } catch (error) {
        // Ignore malformed messages
      }
    });

    krakenWs.on("error", (error) => {
      log(`Kraken WebSocket error: ${error.message}`, "WARN");
    });

    krakenWs.on("close", () => {
      log("Kraken WebSocket disconnected", "WARN");
      handleWsReconnect();
    });

    setTimeout(() => {
      if (!resolve.resolved) {
        resolve.resolved = true;
        resolve();
      }
    }, 30000);
  });
}

function handleWsReconnect() {
  if (wsReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    wsReconnectAttempts++;
    log(`Reconnecting to Kraken WebSocket (attempt ${wsReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`, "WARN");
    setTimeout(() => {
      connectKrakenWebSocket();
    }, RECONNECT_DELAY_MS);
  } else {
    log("Max WebSocket reconnection attempts reached", "ERROR");
  }
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

async function getQuote(inputMint, outputMint, amountRaw) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountRaw),
    slippageBps: String(SLIPPAGE_BPS),
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const response = await fetch(`${JUPITER_QUOTE_API}?${params}`, { 
      headers: {
        'x-api-key': JUPITER_API_KEY
      },
      signal: controller.signal 
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      log(`Jupiter quote API error: ${response.status} ${response.statusText} - ${errorText}`, "ERROR");
      throw new Error(`Jupiter quote API error: ${response.status} ${response.statusText}`);
    }
    const quoteResponse = await response.json();
    if (!quoteResponse || !quoteResponse.outAmount || !quoteResponse.routePlan) {
      throw new Error("Invalid quote response: no routes available for this swap");
    }
    return quoteResponse;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("Jupiter quote API request timed out after 10s");
    }
    throw err;
  }
}

async function getSwapTransaction(quoteResponse) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

  try {
    const response = await fetch(JUPITER_SWAP_API, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "x-api-key": JUPITER_API_KEY
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      log(`Jupiter swap API error: ${response.status} ${response.statusText} - ${errorText}`, "ERROR");
      throw new Error(`Jupiter swap API error: ${response.status} ${response.statusText}`);
    }
    const swapResponse = await response.json();
    if (!swapResponse || !swapResponse.swapTransaction) {
      throw new Error("Invalid swap response: no transaction returned");
    }
    return swapResponse;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("Jupiter swap API request timed out after 15s");
    }
    throw err;
  }
}

async function executeSwapWithRetry(inputMint, outputMint, initialAmountRaw, retries = 3, delayMs = 1000) {
  let currentAmountRaw = initialAmountRaw;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log(`Swap attempt ${attempt}/${retries} for ${currentAmountRaw} units`, "TRADE");
      
      // Step 1: Fetch FRESH quote
      const quote = await getQuote(inputMint, outputMint, currentAmountRaw);
      
      // Receipt Check: Verify if the quote actually meets our threshold after fees
      const outAmount = parseFloat(quote.outAmount);
      const inAmount = parseFloat(currentAmountRaw);
      
      if (inputMint === USDC_MINT) {
        // USDC -> SOL
        const solReceived = outAmount / LAMPORTS_PER_SOL;
        const usdcSpent = inAmount / Math.pow(10, USDC_DECIMALS);
        const effectivePrice = usdcSpent / solReceived;
        const slippagePct = ((effectivePrice - currentKrakenPrice) / currentKrakenPrice) * 100;
        
        log(`Quote Analysis: Kraken Price: $${currentKrakenPrice.toFixed(4)}, Effective Swap Price: $${effectivePrice.toFixed(4)} (${slippagePct.toFixed(2)}% impact)`);
        
        if (slippagePct > 1.0) {
          log(`WARNING: High price impact/slippage detected (${slippagePct.toFixed(2)}%). Fees + Slippage exceed safe limits.`, "WARN");
          if (attempt === retries) throw new Error("Fees/Slippage too high to trade safely");
        }
      } else {
        // SOL -> USDC
        const usdcReceived = outAmount / Math.pow(10, USDC_DECIMALS);
        const solSpent = inAmount / LAMPORTS_PER_SOL;
        const effectivePrice = usdcReceived / solSpent;
        const slippagePct = ((currentKrakenPrice - effectivePrice) / currentKrakenPrice) * 100;

        log(`Quote Analysis: Kraken Price: $${currentKrakenPrice.toFixed(4)}, Effective Swap Price: $${effectivePrice.toFixed(4)} (${slippagePct.toFixed(2)}% impact)`);

        if (slippagePct > 1.0) {
          log(`WARNING: High price impact/slippage detected (${slippagePct.toFixed(2)}%). Fees + Slippage exceed safe limits.`, "WARN");
          if (attempt === retries) throw new Error("Fees/Slippage too high to trade safely");
        }
      }

      // Step 2: Get swap transaction
      const swapResponse = await getSwapTransaction(quote);
      
      // Step 3: Execute swap
      const txid = await executeSwap(swapResponse);
      
      log(`Swap succeeded on attempt ${attempt}: ${txid}`, "TRADE");
      return txid;
    } catch (err) {
      log(`Swap attempt ${attempt} failed: ${err.message}`, "WARN");
      
      const isLiquidityIssue = err.message.includes("no routes available") || 
                               err.message.includes("Could not find a route") ||
                               err.message.includes("Insufficient liquidity");

      if (isLiquidityIssue && attempt < retries) {
        const newAmount = Math.floor(currentAmountRaw * 0.9);
        log(`Liquidity/Route issue detected. Reducing trade amount from ${currentAmountRaw} to ${newAmount} for next attempt.`, "WARN");
        currentAmountRaw = newAmount;
      }

      if (attempt < retries) {
        log(`Retrying in ${delayMs}ms...`, "INFO");
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw new Error(`All ${retries} swap attempts failed. Last error: ${err.message}`);
      }
    }
  }
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
  log(`Initial trading amount: ${tradeAmount.toFixed(2)} USDC (${TRADE_PERCENT * 100}% of ${usdcBalance.toFixed(2)} USDC)`);
  
  const txid = await executeSwapWithRetry(USDC_MINT, SOL_MINT, amountRaw, 3, 1000);
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
  log(`Initial trading amount: ${tradeAmount.toFixed(6)} SOL (${TRADE_PERCENT * 100}% of ${availableSol.toFixed(6)} available SOL)`);
  
  const txid = await executeSwapWithRetry(SOL_MINT, USDC_MINT, amountRaw, 3, 1000);
  return txid;
}

function canTrade() {
  const now = Date.now();
  const cooldownMs = COOLDOWN_SECONDS * 1000;
  const timeSinceLastTrade = now - lastTradeTimestamp;

  // Stop Loss Logic: Ignore cooldown if price is crashing and we hold SOL
  if (lastTradeType === "BUY") {
    const priceChangeSinceBuy = ((currentKrakenPrice - lastReferencePrice) / lastReferencePrice) * 100;
    if (priceChangeSinceBuy <= -1.0) {
      log(`EMERGENCY: Price crashed 1.0% since buy. Breaking cooldown to execute stop-loss.`, "WARN");
      return true;
    }
  }

  if (timeSinceLastTrade < cooldownMs) {
    const remainingCooldown = Math.ceil((cooldownMs - timeSinceLastTrade) / 1000);
    // Reduced logging for cooldown
    if (Math.random() < 0.05) {
      log(`Trade cooldown active. ${remainingCooldown}s remaining.`);
    }
    return false;
  }
  return true;
}

async function checkAndTrade() {
  if (currentKrakenPrice === null) {
    log("No price available yet, waiting for Kraken data...", "WARN");
    return;
  }

  const currentPrice = currentKrakenPrice;

  if (lastReferencePrice === null) {
    lastReferencePrice = currentPrice;
    log(`Initial reference price set: $${lastReferencePrice.toFixed(4)}`);
    return;
  }

  const priceChange = ((currentPrice - lastReferencePrice) / lastReferencePrice) * 100;
  
  // Fresh Anchor Logic: If we are in USDC and price goes LOWER, update reference to catch the new bottom
  if (lastTradeType !== "BUY" && currentPrice < lastReferencePrice) {
    lastReferencePrice = currentPrice;
    log(`New lower bottom found: $${lastReferencePrice.toFixed(4)}. Updating reference.`);
    return;
  }

  // Reduced logging for minor price changes
  if (Math.abs(priceChange) > 0.1) {
    log(`Price: $${currentPrice.toFixed(2)} | Change from ref: ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%`);
  }

  if (!canTrade()) {
    return;
  }

  if (priceChange >= BUY_THRESHOLD && lastTradeType !== "BUY") {
    log(`Price increased by ${priceChange.toFixed(2)}% - triggering BUY`, "TRADE");
    try {
      const txid = await executeBuy();
      if (txid) {
        lastTradeTimestamp = Date.now();
        lastReferencePrice = currentPrice;
        lastTradeType = "BUY";
        log(`BUY completed. New reference price: $${currentPrice.toFixed(4)}`, "TRADE");
      }
    } catch (error) {
      log(`BUY failed: ${error.message}`, "ERROR");
    }
  } else if (priceChange <= -SELL_THRESHOLD && lastTradeType === "BUY") {
    log(`Price decreased by ${Math.abs(priceChange).toFixed(2)}% - triggering SELL`, "TRADE");
    try {
      const txid = await executeSell();
      if (txid) {
        lastTradeTimestamp = Date.now();
        lastReferencePrice = currentPrice;
        lastTradeType = "SELL";
        log(`SELL completed. New reference price: $${currentPrice.toFixed(4)}`, "TRADE");
      }
    } catch (error) {
      log(`SELL failed: ${error.message}`, "ERROR");
    }
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
  log("Solana Jupiter Trading Bot Starting (V2 - Smart Momentum)");
  log("=".repeat(60));

  validateEnvVars();

  connection = new Connection(RPC_URL, COMMITMENT);

  log(`Connected to RPC: ${RPC_URL}`);
  log(`Commitment: ${COMMITMENT}`);

  wallet = loadWallet();
  log(`Wallet loaded: ${wallet.publicKey.toString()}`);

  log(`Price source: Kraken WebSocket`);
  log(`Slippage: ${SLIPPAGE_BPS} bps`);
  log(`Trade percent: ${TRADE_PERCENT * 100}%`);
  log(`Buy threshold: +${BUY_THRESHOLD}%`);
  log(`Sell threshold: -${SELL_THRESHOLD}%`);
  log(`Price check interval: ${PRICE_CHECK_INTERVAL_MS / 1000}s`);
  log(`Trade cooldown: ${ COOLDOWN_SECONDS }s`);

  log("=".repeat(60));
  await displayBalances();
  log("=".repeat(60));

  await connectKrakenWebSocket();

  if (currentKrakenPrice === null) {
    log("Waiting for first price update from Kraken...");
  }

  log("Starting price monitoring loop...");
  await checkAndTrade();
  setInterval(checkAndTrade, PRICE_CHECK_INTERVAL_MS);
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`, "ERROR");
  console.error(error);
  process.exit(1);
});

