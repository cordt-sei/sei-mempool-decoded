# SEI Tendermint Mempool Decoder

Connects to a SEI node to monitor the mempool for unconfirmed txs. It decodes both SEI and Ethereum transactions using protobuf and `@cosmjs` libraries, then broadcasts the decoded information in real-time to connected WebSocket clients.

## Features

- **Transaction Monitoring**: Connects to a SEI Tendermint node via its RPC endpoint to fetch unconfirmed transactions from the mempool. It continuously polls the mempool, retrieving batches of transactions in parallel.

- **Transaction Decoding**:
  - **SEI Transactions**: Decodes `MsgEVMTransaction` messages from the SEI chain, identifying the underlying transaction type (`LegacyTx`, `AccessListTx`, or `DynamicFeeTx`) and extracting relevant fields like `nonce`, `gasLimit`, `gasPrice`, `to`, `value`, `data`, and signatures (`v`, `r`, `s`).
  - **Ethereum Transactions**: The decoded SEI transactions may represent Ethereum-compatible transactions, which are processed to generate readable data such as sender address, transaction hash, and other transaction details.

- **Protobuf-based Decoding**: Utilizes custom protobuf definitions to decode SEI-specific and Ethereum transaction types (`LegacyTx`, `AccessListTx`, and `DynamicFeeTx`), extracting detailed information from each transaction.

- **WebSocket Broadcasting**: Once transactions are decoded, the script sends the transaction details as JSON objects over WebSocket to any connected clients. This allows real-time tracking and analysis of SEI and Ethereum transactions.

- **Transaction Hashing**: The script computes the transaction hash for each transaction, ensuring each transaction is processed only once, and tracks them to prevent duplicates.

- **Real-Time Metrics**: Tracks and logs the number of transactions processed per second, giving an overview of the mempool activity in real-time.
  
