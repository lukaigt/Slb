import { Connection, PublicKey } from "@solana/web3.js";
import { parsePriceData } from "@pythnetwork/client";

const PYTH_SOL_USD_PRICE_ACCOUNT = new PublicKey("J83r8UtrU7ns4fE4sL7xvX2t3f7r3qgwS9ctWk1dVKE");
const PYTH_STALENESS_THRESHOLD_SECONDS = 60;
const PYTH_MAX_CONFIDENCE_RATIO = 0.05;

let connection = null;

function log(message, level = "INFO") {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

export function initPythConnection(rpcUrl, commitment = "confirmed") {
  connection = new Connection(rpcUrl, commitment);
}

export async function getSolPriceUSD() {
  if (!connection) {
    log("Pyth connection not initialized", "ERROR");
    return null;
  }

  try {
    const accountInfo = await connection.getAccountInfo(PYTH_SOL_USD_PRICE_ACCOUNT);
    
    if (!accountInfo || !accountInfo.data) {
      log("Pyth price account not found or empty", "WARN");
      return null;
    }

    const priceData = parsePriceData(accountInfo.data);

    if (!priceData.price || priceData.price <= 0) {
      log("Pyth price invalid: null or <= 0", "WARN");
      return null;
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const publishTime = Number(priceData.publishTime || priceData.timestamp || 0);
    const priceAge = currentTimestamp - publishTime;

    if (priceAge > PYTH_STALENESS_THRESHOLD_SECONDS) {
      log(`Pyth price stale: ${priceAge}s old (max ${PYTH_STALENESS_THRESHOLD_SECONDS}s)`, "WARN");
      return null;
    }

    const price = priceData.price;
    const confidence = priceData.confidence || 0;
    const confidenceRatio = price > 0 ? confidence / price : 1;

    if (confidenceRatio > PYTH_MAX_CONFIDENCE_RATIO) {
      log(`Pyth confidence too wide: ${(confidenceRatio * 100).toFixed(2)}% (max ${PYTH_MAX_CONFIDENCE_RATIO * 100}%)`, "WARN");
      return null;
    }

    const publishDate = new Date(publishTime * 1000).toISOString();
    log(`Pyth SOL/USD: $${price.toFixed(4)} | Confidence: ±$${confidence.toFixed(4)} | Timestamp: ${publishDate}`, "PYTH");

    return price;
  } catch (error) {
    log(`Pyth fetch error: ${error.message}`, "WARN");
    return null;
  }
}
