#!/usr/bin/env node
declare global {
  interface BigInt {
    toJSON: () => string
  }
}

if (!BigInt.prototype.toJSON) {
  Object.defineProperty(BigInt.prototype, "toJSON", {
    value: function () {
      return this.toString()
    },
    writable: true,
    configurable: true
  })
}

import { request, gql } from "graphql-request"
import fetch, { Headers } from "node-fetch"
import fs from "node:fs"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import consola from "consola"

// For the EVM cross-chain transfer snippet:
import { type Address, fallback, http, fromHex, toHex } from "viem"
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing"
import { privateKeyToAccount } from "viem/accounts"
import {
  type ChainId,
  type CosmosChainId,
  createUnionClient,
  type EvmChainId,
  hexToBytes,
  getRecommendedChannels,
  getChannelInfo,
  getQuoteToken
} from "@unionlabs/client"

// Hasura endpoint
const HASURA_ENDPOINT = "https://hubble-green.hasura.app/v1/graphql"

// Set to track reported block hashes
const reportedsendTxHashes = new Set<string>()

// Variable to track sleep cycles
let sleepCycleCount = 0

// Shape of the chain pair config
interface ChainPair {
  sourceChain: string
  destinationChain: string
  timeframeMs: number
  enabled: boolean
}

// Shape of the EVM transfer config
interface TransferConfig {
  enabled: boolean
  privateKey: string
  sourceChainIdEVM: EvmChainId
  sourceChainIdCosmos: CosmosChainId
  destinationChainId: ChainId
  rpcs: Array<string>
  gasPriceDenom: string
  receiverAddress: Address
  denomAddress: Address
  amount_range: Array<bigint>
  cosmosAccountType: string
}

// Combined config shape
interface ConfigFile {
  interactions: Array<ChainPair>
  cycleIntervalMs: number
  transfers?: Array<TransferConfig> // optional array
  privkeys_for_loadtest?: Array<string>
  load_test_enabled: boolean
}

// The shape of Hasura’s response
interface HasuraResponse {
  v1_ibc_union_packets: Array<Packet>
}

// Define our expected shape from Hasura
interface Packet {
  packet_send_timestamp: string | null
  packet_recv_timestamp: string | null
  write_ack_timestamp: string | null
  packet_ack_timestamp: string | null
  packet_send_height: bigint | null

  source_chain_id: string
  destination_chain_id: string

  // optional fields
  packet_send_transaction_hash?: string | null
  packet_recv_transaction_hash?: string | null
  write_ack_transaction_hash?: string | null
  packet_ack_transaction_hash?: string | null
}

// Set global fetch and Headers
if (!globalThis.fetch) {
  globalThis.fetch = fetch as any
}
if (!globalThis.Headers) {
  globalThis.Headers = Headers as any
}

function getRandomArbitrary(min_bigint: bigint, max_bigint: bigint) {
  const min = Number(min_bigint)
  const max = Number(max_bigint)
  const value = Math.random() * (max - min) + min

  return BigInt(Math.ceil(value))
}

// Parse command-line arguments
function loadConfig(configPath: string): ConfigFile {
  if (!fs.existsSync(configPath)) {
    throw new Error("Config file not found. Ensure config.json exists.")
  }

  const rawData = fs.readFileSync(configPath, "utf-8")
  const config = JSON.parse(rawData)

  if (!Array.isArray(config.interactions) || config.interactions.length === 0) {
    throw new Error("Config file is invalid or interactions array is empty.")
  }

  return config
}

/**
 * Check IBC packets between source_chain <-> destination_chain.
 *
 * We fetch the last 200× 'timeframe' from Hasura.
 * For each packet older than timeframe:
 *   - Check RECV / WRITE_ACK / ACK existence & timings.
 *   - Log any that are missing or exceed the time window.
 *
 * @param sourceChain A string ID (e.g. "11155111")
 * @param destinationChain Another string ID (e.g. "17000")
 * @param timeframeMs The SLA timeframe in milliseconds
 */
export async function checkPackets(
  sourceChain: string,
  destinationChain: string,
  timeframeMs: number
): Promise<void> {
  // Current time
  const now = Date.now()

  // We'll query more than the timeframe to ensure we catch all
  const searchRangeMs = timeframeMs * 10
  const sinceDate = new Date(now - searchRangeMs).toISOString()

  consola.info(
    `Querying Hasura for packets >= ${sinceDate}, chain-pair: ${sourceChain} <-> ${destinationChain}`
  )

  // Build the GraphQL query:
  const query = gql`
    query ($since: timestamptz!, $srcChain: String!, $dstChain: String!) {
      v1_ibc_union_packets(
        where: {
          _and: [
            {
              _or: [
                {
                  source_chain_id: { _eq: $srcChain }
                  destination_chain_id: { _eq: $dstChain }
                }
                {
                  source_chain_id: { _eq: $dstChain }
                  destination_chain_id: { _eq: $srcChain }
                }
              ]
            }
            { packet_send_timestamp: { _gte: $since } }
          ]
        }
        order_by: { packet_send_timestamp: asc }
      ) {
        packet_send_timestamp
        packet_recv_timestamp
        write_ack_timestamp
        packet_ack_timestamp
        source_chain_id
        destination_chain_id
        packet_send_transaction_hash
        packet_recv_transaction_hash
        write_ack_transaction_hash
        packet_ack_transaction_hash
        packet_send_height
      }
    }
  `

  const variables = {
    since: sinceDate,
    srcChain: sourceChain,
    dstChain: destinationChain
  }

  try {
    // Post to Hasura
    const response = await request<HasuraResponse>(HASURA_ENDPOINT, query, variables)
    const data = response.v1_ibc_union_packets ?? []

    consola.info(
      `Found ${data.length} packets in the last ${searchRangeMs}ms for ${sourceChain} <-> ${destinationChain}`
    )
    // Check each packet
    for (const p of data) {
      const sendStr = p.packet_send_timestamp
      if (!sendStr) {
        continue
      }

      // Convert sendStr to a Date
      const sendTimeMs = new Date(sendStr).getTime()
      // Only check those older than or equal to SLA timeframe
      if (now - sendTimeMs < timeframeMs) {
        // Not old enough to be considered overdue
        continue
      }

      // If we're here, the packet is older than `timeframeMs`.
      const recvStr = p.packet_recv_timestamp
      const writeAckStr = p.write_ack_timestamp
      const ackStr = p.packet_ack_timestamp

      const sendTxHash = p.packet_send_transaction_hash ?? "?"

      if (reportedsendTxHashes.has(sendTxHash)) {
        continue
      }

      // 1) RECV
      if (recvStr) {
        const recvTimeMs = new Date(recvStr).getTime()
        if (recvTimeMs - sendTimeMs > timeframeMs) {
          // consola.error(
          //   `[RECV TOO LATE] >${timeframeMs}ms. send_time=${sendStr}, recv_time=${recvStr}, sendTxHash=${sendTxHash}`
          // )
          reportedsendTxHashes.add(sendTxHash)
        }
      } else {
        consola.error(
          `[TRANSFER_ERROR: RECV MISSING] >${timeframeMs}ms since send. sendTxHash=${sendTxHash}, source_chain=${p.source_chain_id}, dest_chain=${p.destination_chain_id}, send block_hash: ${p.packet_send_height}`
        )
        reportedsendTxHashes.add(sendTxHash)
        continue
      }

      // 2) WRITE_ACK
      if (writeAckStr) {
        const writeAckTimeMs = new Date(writeAckStr).getTime()
        if (writeAckTimeMs - sendTimeMs > timeframeMs) {
          // consola.error(
          //   `[TRANSFER_ERROR: WRITE_ACK TOO LATE] >${timeframeMs}ms. sendTxHash=${sendTxHash}, send_time=${sendStr}, write_ack_time=${writeAckStr}`
          // )
          reportedsendTxHashes.add(sendTxHash)
        }
      } else {
        consola.error(
          `[TRANSFER_ERROR: WRITE_ACK MISSING] >${timeframeMs}ms since send. sendTxHash=${sendTxHash}, source_chain=${p.source_chain_id}, dest_chain=${p.destination_chain_id}, send block_hash: ${p.packet_send_height}`
        )
        reportedsendTxHashes.add(sendTxHash)
        continue
      }

      // 3) ACK
      if (ackStr) {
        const ackTimeMs = new Date(ackStr).getTime()
        if (ackTimeMs - sendTimeMs > timeframeMs) {
          // consola.error(
          //   `[TRANSFER_ERROR: ACK TOO LATE] >${timeframeMs}ms. send_time=${sendStr}, ack_time=${ackStr}, sendTxHash=${sendTxHash}`
          // )
          reportedsendTxHashes.add(sendTxHash)
        }
      } else {
        consola.error(
          `[TRANSFER_ERROR: ACK MISSING] >${timeframeMs}ms since send. sendTxHash=${sendTxHash}, source_chain=${p.source_chain_id}, dest_chain=${p.destination_chain_id}, send block_hash: ${p.packet_send_height}`
        )
        reportedsendTxHashes.add(sendTxHash)
      }
    }
  } catch (error: any) {
    consola.error("Error fetching data from Hasura:", error.message)
  }
}

/**
 * Perform an EVM cross-chain transfer or estimate the gas for it.
 * Adapt the logic as needed to match your chain IDs / workflow.
 */
async function doTransfer(task: TransferConfig) {
  if (!task.enabled) {
    consola.info("Transfer task is disabled. Skipping.")
    return
  }
  const isCosmosChain = Boolean(task.sourceChainIdCosmos)
  const chainType = isCosmosChain ? "Cosmos" : "EVM"
  const random_amount = getRandomArbitrary(task.amount_range[0], task.amount_range[1])
  try {
    consola.info(
      "\n[%s] Starting transfer for chainId=%s to chain=%s",
      chainType,
      isCosmosChain ? task.sourceChainIdCosmos : task.sourceChainIdEVM,
      task.destinationChainId
    )

    const evmAccount = privateKeyToAccount(`0x${task.privateKey.replace(/^0x/, "")}`)
    const cosmosAccount = await DirectSecp256k1Wallet.fromKey(
      Uint8Array.from(hexToBytes(task.privateKey)),
      task.cosmosAccountType
    )

    const transports = task.rpcs.map(rpc => http(rpc))
    const sourceChainId = isCosmosChain ? task.sourceChainIdCosmos : task.sourceChainIdEVM

    const channels = await getRecommendedChannels()

    const channel = getChannelInfo(sourceChainId, task.destinationChainId, channels)
    if (channel === null) {
      consola.error(
        "No channel found. Source chain ID:",
        sourceChainId,
        " Destination chain ID:",
        task.destinationChainId
      )
      return
    }

    let taskDenomAddr = task.denomAddress
    if (!taskDenomAddr.startsWith("0x")) {
      taskDenomAddr = toHex(taskDenomAddr)
    }
    const quoteToken = await getQuoteToken(sourceChainId, taskDenomAddr, channel)

    // consola.info(
    //   "quoteToken: ",
    //   quoteToken,
    //   " chainId: ",
    //   sourceChainId,
    //   " denomAddr: ",
    //   task.denomAddress,
    //   " channel: ",
    //   channel
    // )

    if (quoteToken.isErr()) {
      consola.info("could not get quote token")
      consola.error(quoteToken.error)
      return
    }

    if ((quoteToken.value.type as string) === "NO_QUOTE_AVAILABLE") {
      consola.info("No quote token available")
      return
    }

    // consola.info("quote token", quoteToken.value)

    const txPayload = isCosmosChain
      ? {
          baseToken: task.denomAddress,
          baseAmount: BigInt(random_amount),
          quoteToken: (quoteToken.value as { quote_token: string }).quote_token,
          quoteAmount: BigInt(random_amount),
          receiver: toHex(task.receiverAddress),
          sourceChannelId: channel.source_channel_id,
          ucs03address: fromHex(`0x${channel.source_port_id}`, "string") as `0x${string}`
        }
      : {
          baseToken: task.denomAddress,
          baseAmount: BigInt(random_amount),
          quoteToken: (quoteToken.value as { quote_token: string }).quote_token,
          quoteAmount: BigInt(random_amount),
          receiver: task.receiverAddress,
          sourceChannelId: channel.source_channel_id,
          ucs03address: `0x${channel.source_port_id}` as `0x${string}`
        }
    let unionClient: any
    if (isCosmosChain) {
      unionClient = createUnionClient({
        account: cosmosAccount,
        chainId: task.sourceChainIdCosmos,
        gasPrice: { amount: "0.025", denom: task.gasPriceDenom },
        transport: transports[0]
      })
    } else {
      unionClient = createUnionClient({
        account: evmAccount,
        chainId: task.sourceChainIdEVM,
        transport: fallback(transports)
      })
      // no need to approve for EVM, already approved all holesky & sepolia it will be waste
      // of time.

      // const approveResponse = await unionClient.approveErc20(txPayload)
      // consola.info("approve response: ", approveResponse)
      // if (approveResponse.isErr()) {
      //   consola.error(approveResponse.error)
      //   return
      // }
    }

    const transferResp = await unionClient.transferAsset(txPayload)
    if (transferResp.isErr()) {
      consola.error(
        "[%s] [%s->%s] Transfer error:",
        chainType,
        isCosmosChain ? task.sourceChainIdCosmos : task.sourceChainIdEVM,
        task.destinationChainId,
        transferResp.error
      )
      return
    }
    consola.info(
      "[%s] [%s->%s] Transfer success:",
      chainType,
      isCosmosChain ? task.sourceChainIdCosmos : task.sourceChainIdEVM,
      task.destinationChainId,
      transferResp.value
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    consola.error(
      "[%s] [%s->%s] Transfer exception: %s",
      isCosmosChain ? task.sourceChainIdCosmos : task.sourceChainIdEVM,
      task.destinationChainId,
      chainType,
      msg
    )
  }
}

/**
 * This loop runs your IBC checks on the interval specified by `config.cycleIntervalMs`.
 * (For example, once every hour if config.cycleIntervalMs = 3600000)
 */
async function runIbcChecksForever(config: ConfigFile) {
  const chainPairs: Array<ChainPair> = config.interactions

  while (true) {
    consola.info("\n========== Starting IBC cross-chain checks ==========")
    for (const pair of chainPairs) {
      if (!pair.enabled) {
        consola.info("Checking task is disabled. Skipping.")
        continue
      }
      consola.info(
        `Checking pair ${pair.sourceChain} <-> ${pair.destinationChain} with timeframe ${pair.timeframeMs}ms`
      )
      try {
        await checkPackets(pair.sourceChain, pair.destinationChain, pair.timeframeMs)
        consola.info(`Check complete for pair ${pair.sourceChain} <-> ${pair.destinationChain}`)
      } catch (err) {
        consola.error(
          `Error while checking pair ${pair.sourceChain} <-> ${pair.destinationChain}:`,
          err
        )
      }
    }

    // Optionally clear the reportedsendTxHashes set every 3 cycles
    sleepCycleCount++
    if (sleepCycleCount % 3 === 0) {
      reportedsendTxHashes.clear()
      consola.info("Cleared reported block hashes.")
    }

    // Sleep for whatever cycleIntervalMs is set to (e.g. 1 hour)
    consola.info(`IBC checks done. Sleeping for ${config.cycleIntervalMs / 1000 / 60} minutes...`)
    await new Promise(resolve => setTimeout(resolve, config.cycleIntervalMs))
  }
}

/**
 * This loop runs your transfer tasks every 10 minutes,
 * regardless of how often IBC checks happen.
 */
async function runTransfersForever(config: ConfigFile) {
  const transfers: Array<TransferConfig> = config.transfers ?? []
  const TEN_MINUTES_MS = 10 * 60 * 1000

  while (true) {
    if (transfers.length > 0) {
      consola.info("\n========== Starting transfers tasks ==========")
      for (const task of transfers) {
        await doTransfer(task)
      }
    } else {
      consola.info("No transfers configured. Skipping transfer step.")
    }

    consola.info(`Transfers done (or skipped). Sleeping 10 minutes...`)
    await new Promise(resolve => setTimeout(resolve, TEN_MINUTES_MS))
  }
}
function sleepSync(ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // Busy-wait for the specified duration
  }
}
/**
 * A "fire-and-forget" style load test function.
 *
 * This will trigger N parallel transfers *without* awaiting their completion.
 *
 * @param task The transfer configuration
 * @param privKeys Optional array of private keys to rotate through
 */
async function doTransferLoadTest(transfers: Array<TransferConfig>, privKeys?: Array<string>) {
  while (true) {
    for (const task of transfers) {
      if (!task.enabled) {
        consola.info("Transfer task is disabled. Skipping.")
        continue
      }
      const useKeys = privKeys && privKeys.length > 0 ? privKeys : [task.privateKey]
      for (let i = 0; i < useKeys.length; i++) {
        const newPrivateKey = useKeys[i]
        const loadTask = { ...task, privateKey: newPrivateKey } // overwrite the key
        consola.info("Starting transfer", i + 1, "with key", newPrivateKey)
        // Fire the asynchronous function but do NOT await
        doTransfer(loadTask).catch(err => {
          consola.error(`[LoadTest] Transfer ${i + 1} failed:`, err)
        })
      }
    }
    // Use non-blocking sleep instead of the synchronous busy-wait.
    await new Promise(resolve => setTimeout(resolve, 15000))
  }
}

/**
 * Kick off both loops in parallel.
 */
async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("config", {
      alias: "c",
      type: "string",
      demandOption: true,
      describe: "Path to the configuration file"
    })
    .help()
    .alias("help", "h")
    .parse()

  const configPath = argv.config
  consola.info(`Using config file: ${configPath}`)

  // Load configuration
  const config = loadConfig(configPath)
  const is_loadtest = config.load_test_enabled ? true : false
  if (is_loadtest) {
    // Run a one-time load test
    const transfers: Array<TransferConfig> = config.transfers ?? []
    if (transfers.length === 0) {
      consola.warn("No transfers configured. Nothing to load-test.")
      return
    }

    consola.info("========== Starting Load Test ==========")
    doTransferLoadTest(transfers, config.privkeys_for_loadtest)

    // You can exit after scheduling them if you don't want
    // to remain running. Or keep the process alive if needed.
    // If you prefer to exit:
    // process.exit(0)
  } else {
    // Normal mode: run IBC checks + transfer tasks in parallel
    await Promise.all([runIbcChecksForever(config), runTransfersForever(config)])
  }
}

// Just call `main()` immediately
main().catch(err => consola.error("Error in main()", err))
