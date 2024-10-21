import { TronWeb } from 'tronweb';
import fs from 'fs';
import poolContractABI from '../cryptosync-frontend/abis/PoolContract.json' assert { type: 'json' };
import dotenv from "dotenv";
import axios from 'axios';

dotenv.config();

const tronWeb = new TronWeb({
  fullHost: 'https://nile.trongrid.io',
  privateKey: process.env.PRIVATE_KEY,
});

const poolABI = poolContractABI.abi;


// Function to fetch all pools from the MongoDB API
async function getAllPools() {
  try {
    const response = await fetch(`${process.env.APP_URL}/api/pools/get-all-pools`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const pools = await response.json();
    // console.log(pools);
    return pools;
  } catch (error) {
    console.error('Error fetching pools from API:', error);
    return [];
  }
}

// Function to check and rebalance pools
async function checkAndRebalancePools() {
  try {
    const pools = await getAllPools();

    // Process pools one by one
    for (const pool of pools) {

      if (pool.poolAddress == null) {
        continue;
      }
      // console.log("Pool in checkAndRebalance", pool);
      await checkAndRebalance(pool);
    }

  } catch (error) {
    console.error('Error in checkAndRebalancePools:', error);
  }
}

// Function to check and rebalance a single pool
async function checkAndRebalance(pool) {
  try {
    console.log("in CheckAndRebalance");
    const poolContract = await tronWeb.contract(poolABI, pool.poolAddress);
    // Fetch timePeriod and lastChecked
    const timePeriodHex = await poolContract.timePeriod().call();

    const currentTime = Math.floor(new Date().getTime() / 1000);
    const lastCheckedHex = await poolContract.lastChecked().call();    

    const timePeriod = Number(timePeriodHex);
    const lastChecked = Number(lastCheckedHex);

    console.log(currentTime, timePeriod, lastChecked);

    // Check if rebalance is due
    if (currentTime >= lastChecked + timePeriod) {
      console.log(`Rebalancing pool ${pool.poolAddress}`);

      // Fetch pool tokens
      const token0 = await poolContract.tokens(0).call();
      const token1 = await poolContract.tokens(1).call();

      // Combine the tokens into an array
      const tokens = [token0, token1];

      // Fetch before status
      const beforeStatus = await getPoolStatus(poolContract);
      console.log("beforeStatus : ", beforeStatus);

      const action = await determineAction(pool, poolContract, beforeStatus);
      console.log("Action:", action);

      // Call rebalance function
      const tx = await poolContract.rebalance().send({
        feeLimit: 1000000000,
        callValue: 0,
      });

      

      console.log(`Rebalanced pool ${pool.poolAddress}: ${tx}`);

      console.log("Tx Id :", tx);
      
      // Fetch after status
      const afterStatus = await getPoolStatus(poolContract);
      console.log("afterStatus : ", afterStatus);

      // POST API for after status
      await postTransactionStatus(action, pool.poolAddress, pool.userWalletAddress, beforeStatus, afterStatus, tx);
    }
  } catch (error) {
    console.error(`Error processing pool ${pool.poolAddress}:`, error);
  }
}

async function determineAction(pool, poolContract, beforeStatus) {
  try {
    console.log("Starting determineAction function");
    console.log("Input beforeStatus:", beforeStatus);

    // Fetch current prices, balances and values
    console.log("Fetching prices...");
    const prices = await poolContract.fetchPrices().call();
    console.log("Raw prices:", prices);
    const [token0Price, token1Price] = prices.map(price => Number(tronWeb.fromSun(price)));
    console.log("Processed prices:", { token0Price, token1Price });

    const [token0Balance, token1Balance] = beforeStatus.map(status => status.tokenPercentage * pool.totalValue / 100);
    console.log("Calculated balances:", { token0Balance, token1Balance });

    const token0Value = token0Balance * token0Price;
    const token1Value = token1Balance * token1Price;
    console.log("Calculated values:", { token0Value, token1Value });

    const threshold = pool.rebalancingThreshold;
    const token0 = pool.tokens[0];
    const token1 = pool.tokens[1];
    console.log("Threshold:", threshold);
    console.log("Token0:", token0);
    console.log("Token1:", token1);

    const targetProportion0 = token0.proportion;
    const takeProfit0 = token0.takeProfitPercentage;
    const takeProfit1 = token1.takeProfitPercentage;
    const stopLoss0 = token0.stopLossAtTokenPrice;
    const stopLoss1 = token1.stopLossAtTokenPrice;
    console.log("Calculated parameters:", {
      targetProportion0,
      takeProfit0,
      takeProfit1,
      stopLoss0,
      stopLoss1
    });

    console.log("Fetching initial token values...");
    const initialValue0 = await poolContract.initialTokenValues(0).call();
    const initialValue1 = await poolContract.initialTokenValues(1).call();
    console.log("Raw initial values:", { initialValue0, initialValue1 });

    const token0InitialValue = Number(tronWeb.fromSun(initialValue0));
    const token1InitialValue = Number(tronWeb.fromSun(initialValue1));
    console.log("Processed initial values:", { token0InitialValue, token1InitialValue });

    // Calculate current proportions
    const currentProportion0 = beforeStatus[0].tokenPercentage;
    console.log("Current proportion of token0:", currentProportion0);

    // Check for stop loss
    console.log("Checking stop loss conditions...");
    if ((token0Price <= stopLoss0 && currentProportion0 != 0)  || (token1Price <= stopLoss1 && currentProportion0 != 100)) {
      console.log("Stop loss triggered");
      return "stop-loss";
    }

    // Check for take profit
    console.log("Calculating profits...");
    const token0Profit = (token0Value - token0InitialValue) * 100 / token0InitialValue;
    const token1Profit = (token1Value - token1InitialValue) * 100 / token1InitialValue;
    console.log("Calculated profits:", { token0Profit, token1Profit });
    
    if ((token0Profit >= takeProfit0 && currentProportion0 != 0 && takeProfit0 != 0) || (token1Profit >= takeProfit1 && currentProportion0 != 0 && takeProfit0 != 0)) {
      console.log("Take profit triggered");
      return "take-profit";
    }

    // Check if rebalance is needed
    console.log("Checking rebalance condition...");
    const diffFromTarget = Math.abs(currentProportion0 - targetProportion0);
    console.log("Difference from target:", diffFromTarget);
    if (diffFromTarget > threshold  && (currentProportion0 != 0 && currentProportion0 != 100)) {
      console.log("Rebalance needed");
      return "rebalance";
    }

    // If none of the above conditions are met, no action is needed
    console.log("No action needed");
    return "no-action";
  } catch (error) {
    console.error("Error in determineAction:", error);
    console.error("Error details:", error.message);
    if (error.stack) console.error("Error stack:", error.stack);
    return "ERROR";
  }
}

async function getPoolStatus(poolContract) {
  try {
    console.log("Fetching pool status in USD...");
    const result = await poolContract.getTokenBalanceInUSD().call();
    const totalValueInUSD = tronWeb.fromSun(result.totalValueInUSD.toString());
    const valueProportions = result.valueProportions.map(proportion => Number(proportion) / 100); // Convert BPS to percentage

    console.log("Total Value in USD:", totalValueInUSD, "Value Proportions:", valueProportions);

    if (totalValueInUSD <= 0) {
      console.log("Total value is zero or negative, returning default status.");
      return [{ tokenName: 'Token0', tokenPercentage: 0 }, { tokenName: 'Token1', tokenPercentage: 0 }];
    }

    const status = [
      { tokenName: 'Token0', tokenPercentage: valueProportions[0] },
      { tokenName: 'Token1', tokenPercentage: valueProportions[1] }
    ];

    console.log("Pool Status:", status);
    return status;
  } catch (error) {
    console.error("Error fetching pool status in USD:", error);
    return [{ tokenName: 'Token0', tokenPercentage: 0 }, { tokenName: 'Token1', tokenPercentage: 0 }];
  }
}

// Updated function to post transaction status to the API
async function postTransactionStatus(action, poolAddress, userWalletAddress, beforeStatus, afterStatus, tx) {
  try {
    console.log("Post request : ", {
      type: action,
      txHash: tx,
      description: 'Automatic rebalancing completed',
      tokenBefore: beforeStatus,
      tokenAfter: afterStatus,
      amount: 0, // Set this to the appropriate value if needed
      userId: userWalletAddress, // Make sure to set this in your .env file
      poolId: poolAddress
    });

    const response = await axios.post(`${process.env.APP_URL}/api/pools/transactions/create`, {
      type: action,
      txHash: tx,
      description: 'Automatic rebalancing completed',
      tokenBefore: beforeStatus,
      tokenAfter: afterStatus,
      amount: 0, // Set this to the appropriate value if needed
      userId: userWalletAddress, // Make sure to set this in your .env file
      poolId: poolAddress,
    });
    if (response.status === 201) {
      console.log(`Transaction status posted for rebalance:`, response.data);
    } else {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  } catch (error) {
    console.error(`Error posting transaction status for rebalance:`, error);
  }
}

// Function to run the continuous loop
async function startMonitoring() {
  // Define the interval in milliseconds (e.g., 1 minute)
  const INTERVAL_MS = 60 * 1000;

  while (true) {
    await checkAndRebalancePools();
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }
}

// Start the monitoring loop
startMonitoring();

// Global error handlers
process.on('uncaughtException', function (err) {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', function (reason, p) {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});