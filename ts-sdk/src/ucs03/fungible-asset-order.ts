import { toHex, type Address } from "viem"
import { Effect, Schema as S } from "effect"
import { ViemPublicClient, ViemPublicClientSource } from "../evm/client.js"
import { readErc20Meta } from "../evm/erc20.js"
import { predictQuoteToken as predictEvmQuoteToken } from "../evm/quote-token.js"
import { CosmWasmClientContext, CosmWasmClientSource } from "../cosmos/client.js"
import { AptosPublicClient } from "../aptos/client.js"
import { readCw20TokenInfo } from "../cosmos/cw20.js"
import { readFaTokenInfo } from "../aptos/fa.js"
import { predictQuoteToken as predictCosmosQuoteToken } from "../cosmos/quote-token.js"
import { predictQuoteToken as predictAptosQuoteToken } from "../aptos/quote-token.js"
import { FungibleAssetOrder } from "./instruction.js"
import { AddressCosmosZkgm, AddressEvmZkgm } from "../schema/address.js"
import { TokenRawDenom } from "../schema/token.js"
import { ensureHex } from "../utils/index.js"

const guardAgainstZeroAmount = (intent: { baseAmount: bigint; quoteAmount: bigint }) => {
  if (intent.baseAmount <= 0n) {
    return Effect.fail(new Error("baseAmount must be greater than zero"))
  }
  return Effect.succeed(intent)
}

/**
 * Creates a fungible asset order from EVM to EVM
 */
type EvmToEvmIntent = {
  sender: AddressEvmZkgm
  receiver: AddressEvmZkgm
  baseToken: TokenRawDenom
  baseAmount: bigint
  quoteAmount: bigint
}
export const createEvmToEvmFungibleAssetOrder = (
  intent: EvmToEvmIntent
) =>
  Effect.gen(function* () {
    yield* guardAgainstZeroAmount(intent)
    const sourceClient = (yield* ViemPublicClientSource).client
    const tokenMeta = yield* readErc20Meta(intent.baseToken as Address).pipe(
      Effect.provideService(ViemPublicClient, { client: sourceClient })
    )
    const quoteToken = yield* predictEvmQuoteToken(intent.baseToken)

    return yield* S.decode(FungibleAssetOrder)({
      _tag: "FungibleAssetOrder",
      operand: [
        intent.sender,
        intent.receiver,
        intent.baseToken,
        intent.baseAmount,
        tokenMeta.symbol,
        tokenMeta.name,
        tokenMeta.decimals,
        0n, // channel if unwrapping
        quoteToken,
        intent.quoteAmount
      ]
    })
  })

/**
 * Creates a fungible asset order from EVM to Cosmos
 */
type EvmToCosmosIntent = {
  sender: AddressEvmZkgm
  receiver: AddressCosmosZkgm
  baseToken: TokenRawDenom
  baseAmount: bigint
  quoteAmount: bigint
}
export const createEvmToCosmosFungibleAssetOrder = (
  intent: EvmToCosmosIntent
) =>
  Effect.gen(function* () {
    yield* guardAgainstZeroAmount(intent)
    yield* Effect.log("creating client")
    const sourceClient = (yield* ViemPublicClientSource).client
    yield* Effect.log("reading erc20 meta")
    const tokenMeta = yield* readErc20Meta(intent.baseToken as Address).pipe(
      Effect.provideService(ViemPublicClient, { client: sourceClient })
    )
    yield* Effect.log("predicting quote token")
    const quoteToken = yield* predictCosmosQuoteToken(intent.baseToken)
    yield* Effect.log("quote token", quoteToken)

    console.log("[FAO]", {
      sender: intent.sender,
      receiver: intent.receiver,
    })

    return yield* S.decode(FungibleAssetOrder)({
      _tag: "FungibleAssetOrder",
      operand: [
        intent.sender,
        intent.receiver,
        ensureHex(intent.baseToken),
        intent.baseAmount,
        tokenMeta.symbol,
        tokenMeta.name,
        tokenMeta.decimals,
        0n, // channel if unwrapping
        quoteToken,
        intent.quoteAmount
      ]
    })
  }).pipe(Effect.withLogSpan("create fungible asset order"))

/**
 * Creates a fungible asset order from Cosmos to EVM
 */
type CosmosToEvmIntent = {
  sender: AddressCosmosZkgm
  receiver: AddressEvmZkgm
  baseToken: string
  baseAmount: bigint
  quoteAmount: bigint
}
export const createCosmosToEvmFungibleAssetOrder = (
  intent: CosmosToEvmIntent
) =>
  Effect.gen(function* () {
    yield* guardAgainstZeroAmount(intent)
    const sourceClient = (yield* CosmWasmClientSource).client

    // HACK: special cased for ubbn for now
    const tokenMeta =
      intent.baseToken === "ubbn"
        ? {
            symbol: "ubbn",
            name: "ubbn",
            decimals: 0
          }
        : yield* readCw20TokenInfo(intent.baseToken).pipe(
            Effect.provideService(CosmWasmClientContext, { client: sourceClient })
          )

    const quoteToken = yield* predictEvmQuoteToken(ensureHex(intent.baseToken))

    console.log("here", intent)
    return yield* S.decode(FungibleAssetOrder)({
      _tag: "FungibleAssetOrder",
      operand: [
        intent.sender,
        intent.receiver,
        ensureHex(intent.baseToken),
        intent.baseAmount,
        tokenMeta.symbol,
        tokenMeta.name,
        tokenMeta.decimals,
        0n, // channel if unwrapping
        quoteToken,
        intent.quoteAmount
      ]
    })
  })

/**
 * Creates a fungible asset order from Cosmos to Cosmos
 */
type CosmosToCosmosIntent = {
  sender: AddressCosmosZkgm,
  receiver: AddressCosmosZkgm
  baseToken: string
  baseAmount: bigint
  quoteAmount: bigint
}

export const createCosmosToCosmosFungibleAssetOrder = (
  intent: CosmosToCosmosIntent
) =>
  Effect.gen(function* () {
    yield* guardAgainstZeroAmount(intent)
    const sourceClient = (yield* CosmWasmClientSource).client
    const tokenMeta = yield* readCw20TokenInfo(intent.baseToken).pipe(
      Effect.provideService(CosmWasmClientContext, { client: sourceClient })
    )
    const quoteToken = yield* predictCosmosQuoteToken(toHex(intent.baseToken))

    return yield* S.decode(FungibleAssetOrder)({
      _tag: "FungibleAssetOrder",
      operand: [
        intent.sender,
        intent.receiver,
        ensureHex(intent.baseToken),
        intent.baseAmount,
        tokenMeta.symbol,
        tokenMeta.name,
        tokenMeta.decimals,
        0n, // channel if unwrapping
        quoteToken,
        intent.quoteAmount
      ]
    })
  })

/**
 * Creates a fungible asset order from Aptos to Cosmos
 */
type CosmosToAptosIntent = {
  sender: string
  receiver: string
  baseToken: string
  baseAmount: bigint
  quoteAmount: bigint
}
export const createCosmosToAptosFungibleAssetOrder = (
  intent: CosmosToAptosIntent
) =>
  Effect.gen(function* () {
    yield* guardAgainstZeroAmount(intent)
    const sourceClient = (yield* CosmWasmClientSource).client
    // HACK: special cased for muno for now
    const tokenMeta =
      intent.baseToken === "muno"
        ? {
            symbol: "muno",
            name: "muno",
            decimals: 0
          }
        : yield* readCw20TokenInfo(intent.baseToken).pipe(
            Effect.provideService(CosmWasmClientContext, { client: sourceClient })
          )

    const quoteToken = yield* predictAptosQuoteToken(toHex(intent.baseToken))

    yield* Effect.log("quote token from aptos is", quoteToken, " for base token ", intent.baseToken)

    return yield* S.decode(FungibleAssetOrder)({
      _tag: "FungibleAssetOrder",
      operand: [
        toHex(intent.sender),
        toHex(intent.receiver),
        toHex(intent.baseToken),
        intent.baseAmount,
        tokenMeta.symbol,
        tokenMeta.name,
        tokenMeta.decimals,
        0n, // channel if unwrapping
        quoteToken,
        intent.quoteAmount
      ]
    })
  })

/**
 * Creates a fungible asset order from Cosmos to Aptos
 */
type AptosToCosmosIntent = {
  sender: string
  receiver: string
  baseToken: string
  baseAmount: bigint
  quoteAmount: bigint
}
export const createAptosToCosmosFungibleAssetOrder = (
  intent: AptosToCosmosIntent
) =>
  Effect.gen(function* () {
    yield* guardAgainstZeroAmount(intent)
    const sourceClient = (yield* AptosPublicClient).client
    const tokenMeta = yield* readFaTokenInfo(intent.baseToken).pipe(
      Effect.provideService(AptosPublicClient, { client: sourceClient })
    )
    const quoteToken = yield* predictCosmosQuoteToken(toHex(intent.baseToken))

    return yield* S.decode(FungibleAssetOrder)({
      _tag: "FungibleAssetOrder",
      operand: [
        toHex(intent.sender),
        toHex(intent.receiver),
        toHex(intent.baseToken),
        intent.baseAmount,
        tokenMeta.symbol,
        tokenMeta.name,
        tokenMeta.decimals,
        0n, // channel if unwrapping
        quoteToken,
        intent.quoteAmount
      ]
    })
  })

export type FungibleAssetOrderIntent =
  | EvmToEvmIntent
  | EvmToCosmosIntent
  | CosmosToCosmosIntent
  | CosmosToEvmIntent

export type EvmSourceIntent =
  | EvmToEvmIntent
  | EvmToCosmosIntent