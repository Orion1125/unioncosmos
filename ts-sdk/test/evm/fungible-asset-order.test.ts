import { assert, describe, it, expect } from "@effect/vitest"
import { type Context, Effect, Exit, Layer } from "effect"
import { ViemPublicClientSource, ViemPublicClientDestination } from "../../src/evm/client.js"
import { CosmWasmClientSource, CosmWasmClientDestination } from "../../src/cosmos/client.js"
import { EvmChannelDestination } from "../../src/evm/channel.js"
import { CosmosChannelDestination } from "../../src/cosmos/channel.js"
import {
  createEvmToEvmFungibleAssetOrder,
  createEvmToCosmosFungibleAssetOrder,
  createCosmosToEvmFungibleAssetOrder,
  createCosmosToCosmosFungibleAssetOrder
} from "../../src/ucs03/fungible-asset-order.js"
import { toHex } from "viem"

// Mock data for tests
const mockErc20Meta = {
  name: "Mock ERC20",
  symbol: "MOCK",
  decimals: 18
}

const mockCw20TokenInfo = {
  name: "Mock CW20",
  symbol: "MCKT",
  decimals: 6,
  total_supply: "1000000000"
}

const mockEvmQuoteToken = "0x123" as const
const mockCosmosQuoteToken = "0x123" as const

// Mock clients
const mockViemPublicClientSource = {
  client: {
    readContract: (params: any) => {
      // This simulates reading ERC20 metadata based on the function name
      if (params.functionName === "name") return mockErc20Meta.name
      if (params.functionName === "symbol") return mockErc20Meta.symbol
      if (params.functionName === "decimals") return mockErc20Meta.decimals
      return null
    }
  }
}

const mockViemPublicClientDestination = {
  client: {
    readContract: () => {
      // This simulates predicting a quote token
      return [mockEvmQuoteToken]
    }
  }
}

const mockCosmWasmClientSource = {
  client: {
    queryContractSmart: (_contractAddress: string, query: any) => {
      // This simulates reading CW20 token info
      if (query.token_info) {
        return mockCw20TokenInfo
      }
      if (query.balance) {
        return { balance: "1000000" }
      }
      return null
    }
  }
}

const mockCosmWasmClientDestination = {
  client: {
    queryContractSmart: (_contractAddress: string, query: any) => {
      // This simulates predicting a quote token
      if (query.predict_wrapped_token) {
        return { wrapped_token: mockCosmosQuoteToken }
      }
      return null
    }
  }
}

// Test data
const evmIntent = {
  sender: "0x123" as const,
  receiver: "0x123" as const,
  baseToken: "0x123" as const,
  baseAmount: 1000000000000000000n, // 1 token with 18 decimals
  quoteAmount: 500000000000000000n // 0.5 token with 18 decimals
} as const

const cosmosIntent = {
  sender: "cosmos1sender",
  receiver: "0x123",
  baseToken: "cosmos1basetoken",
  baseAmount: BigInt(1000000), // 1 token with 6 decimals
  quoteAmount: BigInt(500000) // 0.5 token with 6 decimals
} as const

const EvmToEvm = Layer.mergeAll(
  // @ts-expect-error
  Layer.succeed(ViemPublicClientSource, mockViemPublicClientSource),
  // @ts-expect-error
  Layer.succeed(ViemPublicClientDestination, mockViemPublicClientDestination),
  Layer.succeed(EvmChannelDestination, {
    ucs03address: "0xUCS03Address",
    channelId: 1
  })
)

const EvmToCosmos = Layer.mergeAll(
  // @ts-expect-error
  Layer.succeed(ViemPublicClientSource, mockViemPublicClientSource),
  // @ts-expect-error
  Layer.succeed(CosmWasmClientDestination, mockCosmWasmClientDestination),
  Layer.succeed(CosmosChannelDestination, {
    ucs03address: "cosmos1ucs03address",
    channelId: 1
  })
)

const CosmosToEvm = Layer.mergeAll(
  // @ts-expect-error
  Layer.succeed(CosmWasmClientSource, mockCosmWasmClientSource),
  // @ts-expect-error
  Layer.succeed(ViemPublicClientDestination, mockViemPublicClientDestination),
  Layer.succeed(EvmChannelDestination, {
    ucs03address: "0xUCS03Address",
    channelId: 1
  })
)

const CosmosToCosmos = Layer.mergeAll(
  // @ts-expect-error
  Layer.succeed(CosmWasmClientSource, mockCosmWasmClientSource),
  // @ts-expect-error
  Layer.succeed(CosmWasmClientDestination, mockCosmWasmClientDestination),
  Layer.succeed(CosmosChannelDestination, {
    ucs03address: "cosmos1ucs03address",
    channelId: 1
  })
)

const EvmToEvmError = Layer.mergeAll(
  EvmToEvm,
  Layer.succeed(ViemPublicClientSource, {
    client: {
      readContract: async () => {
        throw new Error("Mock error")
      }
    }
  } as unknown as Context.Tag.Service<ViemPublicClientSource>)
)

const CosmosToCosmosError = Layer.mergeAll(
  CosmosToCosmos,
  Layer.succeed(CosmWasmClientSource, {
    client: {
      queryContractSmart: async () => {
        throw new Error("Mock error")
      }
    }
  } as unknown as Context.Tag.Service<CosmWasmClientSource>)
)

describe("Fungible Asset Order Tests", () => {
  it.layer(EvmToEvm)("EVM to EVM", it => {
    it.effect("should create a fungible asset order from EVM to EVM", () =>
      Effect.gen(function* () {
        const result = yield* createEvmToEvmFungibleAssetOrder(evmIntent)
        assert.deepStrictEqual(result, {
          _tag: "FungibleAssetOrder",
          opcode: 3,
          version: 1,
          operand: [
            evmIntent.sender,
            evmIntent.receiver,
            evmIntent.baseToken,
            evmIntent.baseAmount,
            mockErc20Meta.symbol,
            mockErc20Meta.name,
            mockErc20Meta.decimals,
            0n,
            mockEvmQuoteToken,
            evmIntent.quoteAmount
          ]
        })
      })
    )
  })

  it.layer(EvmToCosmos)("EVM to Cosmos", it => {
    it.effect("should create a fungible asset order from EVM to Cosmos", () =>
      Effect.gen(function* () {
        const result = yield* createEvmToCosmosFungibleAssetOrder(evmIntent)
        assert.deepStrictEqual(result, {
          _tag: "FungibleAssetOrder",
          opcode: 3,
          version: 1,
          operand: [
            evmIntent.sender,
            "0x3078313233",
            evmIntent.baseToken,
            evmIntent.baseAmount,
            mockErc20Meta.symbol,
            mockErc20Meta.name,
            mockErc20Meta.decimals,
            0n,
            mockCosmosQuoteToken,
            evmIntent.quoteAmount
          ]
        })
      })
    )
  })

  it.layer(CosmosToEvm)("Cosmos to EVM", it => {
    it.effect("should create a fungible asset order from Cosmos to EVM", () =>
      Effect.gen(function* () {
        const result = yield* createCosmosToEvmFungibleAssetOrder(cosmosIntent)
        assert.deepStrictEqual(result, {
          _tag: "FungibleAssetOrder",
          opcode: 3,
          version: 1,
          operand: [
            toHex(cosmosIntent.sender),
            "0x123",
            toHex(cosmosIntent.baseToken),
            cosmosIntent.baseAmount,
            mockCw20TokenInfo.symbol,
            mockCw20TokenInfo.name,
            mockCw20TokenInfo.decimals,
            0n,
            mockEvmQuoteToken,
            cosmosIntent.quoteAmount
          ]
        })
      })
    )
  })

  it.layer(CosmosToCosmos)("Cosmos to Cosmos", it => {
    it.effect("should create a fungible asset order from Cosmos to Cosmos", () =>
      Effect.gen(function* () {
        const result = yield* createCosmosToCosmosFungibleAssetOrder(cosmosIntent)
        assert.deepStrictEqual(result, {
          _tag: "FungibleAssetOrder",
          opcode: 3,
          version: 1,
          operand: [
            toHex(cosmosIntent.sender),
            toHex(cosmosIntent.receiver),
            toHex(cosmosIntent.baseToken),
            cosmosIntent.baseAmount,
            mockCw20TokenInfo.symbol,
            mockCw20TokenInfo.name,
            mockCw20TokenInfo.decimals,
            0n,
            mockCosmosQuoteToken,
            cosmosIntent.quoteAmount
          ]
        })
      })
    )
  })

  describe("Error handling", () => {
    it.layer(EvmToEvmError)(it => {
      it.effect("should handle errors when creating EVM to EVM fungible asset order", () =>
        Effect.gen(function* () {
          const result = yield* Effect.exit(createEvmToEvmFungibleAssetOrder(evmIntent))
          assert.isTrue(Exit.isFailure(result))
        })
      )
    })

    it.layer(CosmosToCosmosError)(it => {
      it.effect("should handle errors when creating Cosmos to Cosmos fungible asset order", () =>
        Effect.gen(function* () {
          const result = yield* Effect.exit(createCosmosToCosmosFungibleAssetOrder(cosmosIntent))
          expect(Exit.isFailure(result)).toBe(true)
        })
      )
    })
  })
})
