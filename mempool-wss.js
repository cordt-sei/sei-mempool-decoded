const axios = require("axios");
const { fromBase64 } = require("@cosmjs/encoding");
const { decodeTxRaw } = require("@cosmjs/proto-signing");
const protobuf = require("protobufjs");
const { ethers } = require("ethers");
const WebSocket = require("ws");

// Replace with your Cosmos node's RPC URL
const rpcUrl = 'http://localhost:26657';

// Ethereum provider
const ethProvider = new ethers.providers.WebSocketProvider("ws://localhost:8545");

// Create a WebSocket server
const wss = new WebSocket.Server({ port: 1337 });

wss.on("connection", (ws) => {
  console.log("Client connected");
  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

function getTransactionDetails(rawTx, type) {
  const tx = {
    nonce: parseInt(rawTx.nonce, 10),
    gasLimit: ethers.BigNumber.from(rawTx.gasLimit),
    to: rawTx.to,
    value: ethers.utils.parseEther(rawTx.value || "0.0"),
    data: rawTx.data,
    chainId: 1329,
    v: rawTx.v && rawTx.v !== "0x" ? ethers.BigNumber.from(rawTx.v) : ethers.BigNumber.from(0),
    r: rawTx.r,
    s: rawTx.s,
  };

  if (type === "LegacyTx" || type === "AccessListTx") {
    tx.gasPrice = ethers.utils.parseUnits(rawTx.gasPrice, "gwei");
  } else if (type === "DynamicFeeTx") {
    tx.maxPriorityFeePerGas = ethers.utils.parseUnits(rawTx.gasTipCap, "gwei");
    tx.maxFeePerGas = ethers.utils.parseUnits(rawTx.gasFeeCap, "gwei");
  }

  const vNumber = ethers.BigNumber.from(tx.v).toNumber();

  // Serialize the transaction without v, r, s
  const unsignedTx = {
    nonce: tx.nonce,
    gasLimit: tx.gasLimit,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    chainId: tx.chainId,
  };

  if (type === "LegacyTx" || type === "AccessListTx") {
    unsignedTx.gasPrice = tx.gasPrice;
  } else if (type === "DynamicFeeTx") {
    unsignedTx.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
    unsignedTx.maxFeePerGas = tx.maxFeePerGas;
    unsignedTx.type = 2; // Ensure transaction type is set to EIP-1559
  }

  // Serialize the transaction
  const serializedTx = ethers.utils.serializeTransaction(unsignedTx, { v: vNumber, r: tx.r, s: tx.s });

  // Calculate the transaction hash
  const txHash = ethers.utils.keccak256(serializedTx);

  // Recover the sender address
  const senderAddress = ethers.utils.recoverAddress(
    ethers.utils.keccak256(ethers.utils.serializeTransaction(unsignedTx)),
    { r: tx.r, s: tx.s, v: vNumber }
  );

  return {
    sender: senderAddress,
    hash: txHash,
    nonce: tx.nonce,
  };
}

async function loadProtobuf() {
  // Load the protobuf definitions from the files
  const root = await protobuf.load("proto/tx.proto");
  const root2 = await protobuf.load("proto/eth/tx.proto");
  return {
    MsgEVMTransaction: root.lookupType("seiprotocol.seichain.evm.MsgEVMTransaction"),
    LegacyTx: root2.lookupType("seiprotocol.seichain.eth.LegacyTx"),
    DynamicFeeTx: root2.lookupType("seiprotocol.seichain.eth.DynamicFeeTx"),
    AccessListTx: root2.lookupType("seiprotocol.seichain.eth.AccessListTx"),
  };
}

async function checkPendingTransactions() {
  const { MsgEVMTransaction, LegacyTx, DynamicFeeTx, AccessListTx } = await loadProtobuf();
  const seenTransactions = new Set(); // Track seen transaction hashes
  const pageSize = 15; // Number of pages to fetch at once

  let transactionCount = 0; // Track transactions per second

  // Log transactions per second
  setInterval(() => {
    console.log(`Transactions sent per second: ${transactionCount}`);
    transactionCount = 0; // Reset count for the next second
  }, 1000);

  while (true) {
    const currentBatchHashes = new Set(); // Set to track hashes in the current batch
    let page = 1;

    while (true) {
      try {
        // Fetch in parallel
        const pagePromises = [];
        for (let i = 0; i < pageSize; i++) {
          pagePromises.push(axios.get(`${rpcUrl}/unconfirmed_txs?page=${page + i}&per_page=100`));
        }

        const pageResponses = await Promise.all(pagePromises);

        let transactionsExist = false;

        for (const response of pageResponses) {
          if (!response || !response.data || !response.data.txs) {
            // If there's an invalid response, skip it
            break;
          }

          const { txs } = response.data;

          if (txs && txs.length > 0) {
            transactionsExist = true;

            await Promise.all(
              txs.map(async (txBase64) => {
                const txBytes = fromBase64(txBase64);

                try {
                  const decodedTx = decodeTxRaw(txBytes);
                  const txHash = ethers.utils.keccak256(txBytes); // Hash the transaction bytes

                  // Only process new transactions
                  if (!seenTransactions.has(txHash)) {
                    seenTransactions.add(txHash); // Mark transaction as seen

                    const { messages } = decodedTx.body;
                    await Promise.all(
                      messages.map(async (msg) => {
                        const typeUrl = msg.typeUrl;

                        // Catch and decode other typeUrls through their respective protobuf definitions
                        if (typeUrl === "/seiprotocol.seichain.evm.MsgEVMTransaction") {
                          const decodedMsgEVMTransaction = MsgEVMTransaction.decode(msg.value);
                          const innerTypeUrl = decodedMsgEVMTransaction.data.type_url;
                          const value = decodedMsgEVMTransaction.data.value;

                          let decodedInnerTx;
                          let readableTx = {};
                          switch (innerTypeUrl) {
                            case "/seiprotocol.seichain.eth.LegacyTx":
                              decodedInnerTx = LegacyTx.decode(value);
                              readableTx = {
                                type: "LegacyTx",
                                nonce: decodedInnerTx.nonce.toString(),
                                gasPrice: ethers.utils.formatUnits(decodedInnerTx.gasPrice, "gwei"),
                                gasLimit: decodedInnerTx.gasLimit.toString(),
                                to: decodedInnerTx.to,
                                value: ethers.utils.formatEther(decodedInnerTx.value),
                                data: ethers.utils.hexlify(decodedInnerTx.data),
                                v: ethers.utils.hexlify(decodedInnerTx.v),
                                r: ethers.utils.hexlify(decodedInnerTx.r),
                                s: ethers.utils.hexlify(decodedInnerTx.s),
                              };
                              break;
                            case "/seiprotocol.seichain.eth.DynamicFeeTx":
                              decodedInnerTx = DynamicFeeTx.decode(value);
                              readableTx = {
                                type: "DynamicFeeTx",
                                nonce: decodedInnerTx.nonce.toString(),
                                gasTipCap: ethers.utils.formatUnits(decodedInnerTx.gasTipCap, "gwei"),
                                gasFeeCap: ethers.utils.formatUnits(decodedInnerTx.gasFeeCap, "gwei"),
                                gasLimit: decodedInnerTx.gasLimit.toString(),
                                to: decodedInnerTx.to,
                                value: ethers.utils.formatEther(decodedInnerTx.value),
                                data: ethers.utils.hexlify(decodedInnerTx.data),
                                v: ethers.utils.hexlify(decodedInnerTx.v),
                                r: ethers.utils.hexlify(decodedInnerTx.r),
                                s: ethers.utils.hexlify(decodedInnerTx.s),
                              };
                              break;
                            case "/seiprotocol.seichain.eth.AccessListTx":
                              decodedInnerTx = AccessListTx.decode(value);
                              readableTx = {
                                type: "AccessListTx",
                                nonce: decodedInnerTx.nonce.toString(),
                                gasPrice: ethers.utils.formatUnits(decodedInnerTx.gasPrice, "gwei"),
                                gasLimit: decodedInnerTx.gasLimit.toString(),
                                to: decodedInnerTx.to,
                                value: ethers.utils.formatEther(decodedInnerTx.value),
                                data: ethers.utils.hexlify(decodedInnerTx.data),
                                v: ethers.utils.hexlify(decodedInnerTx.v),
                                r: ethers.utils.hexlify(decodedInnerTx.r),
                                s: ethers.utils.hexlify(decodedInnerTx.s),
                              };
                              break;
                            default:
                              break;
                          }

                          if (decodedInnerTx) {
                            // Prepare the new transaction details in a JSON format
                            const datetime = new Date();
                            const datetimeFormatted = datetime.toISOString();
                            const date = { date: datetimeFormatted }
                            const transactionDetails = getTransactionDetails(readableTx, readableTx.type);
                            const transactionJson = JSON.stringify({
                              ...readableTx,
                              ...transactionDetails,
                              ...date,
                            });

                            // Broadcast transaction to all connected clients
                            wss.clients.forEach((client) => {
                              if (client.readyState === WebSocket.OPEN) {
                                client.send(transactionJson);
                                transactionCount++; // Increment the transaction count
                              }
                            });
                          }
                        }
                      })
                    );
                  }

                  currentBatchHashes.add(txHash); // Add the current transaction hash to the batch
                } catch (error) {
                  console.error("Error decoding transaction:", error);
                }
              })
            );
          }
        }

        // Remove transactions that are no longer in the current batch from the seen set
        for (const txHash of seenTransactions) {
          if (!currentBatchHashes.has(txHash)) {
            seenTransactions.delete(txHash);
          }
        }

        // If no transactions were found in the last batch, exit the current loop
        if (!transactionsExist) {
          break;
        }

        page += pageSize; // Increment page number by batch size
      } catch (error) {
        if (error.response && error.response.data && error.response.data.message.includes("Invalid request")) {
          break;
        } else {
          console.error("Error fetching unconfirmed transactions:", error);
          break;
        }
      }
    }
  }
}

// Start the loop
checkPendingTransactions().catch(console.error);
