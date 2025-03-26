import { Effect } from "effect"
import { CosmWasmClientContext } from "./client.js"
import { queryContract } from "./contract.js"

/**
 * Interface for CW20 token metadata
 */
export interface Cw20TokenInfo {
  name: string
  symbol: string
  decimals: number
  total_supply: string
}

/**
 * Interface for CW20 token balance response
 */
export interface Cw20BalanceResponse {
  balance: string
}


/**
 * Interface for CW20 token balance response
 */
export interface Cw20AllowanceResponse {
  allowance: number
  expiration: any
}

/**
 * Read CW20 token metadata (name, symbol, decimals, total_supply)
 * @param contractAddress The address of the CW20 token contract
 * @returns An Effect that resolves to the token metadata
 */
export const readCw20TokenInfo = (contractAddress: string) =>
  Effect.gen(function* () {
    const client = (yield* CosmWasmClientContext).client

    return yield* queryContract<Cw20TokenInfo>(client, contractAddress, { token_info: {} })
  })

/**
 * Read the balance of a CW20 token for a specific address
 * @param contractAddress The address of the CW20 token contract
 * @param address The address to check the balance for
 * @returns An Effect that resolves to the token balance
 */
export const readCw20Balance = (contractAddress: string, address: string) =>
  Effect.gen(function* () {
    const client = (yield* CosmWasmClientContext).client

    const response = yield* queryContract<Cw20BalanceResponse>(client, contractAddress, {
      balance: {
        address
      }
    })

    return response.balance
  })

  /**
 * Read the allowance of a CW20 token for a specific addresses
 * @param contractAddress The address of the CW20 token contract
 * @param ownerAddress The owner of the token
 * @param spenderAddress The spender who will spend the token
 * @returns An Effect that resolves to the token allowance
 */
export const readCw20Allowance = (contractAddress: string, ownerAddress: string, spenderAddress: string) =>
  Effect.gen(function* () {
    const client = (yield* CosmWasmClientContext).client

    const response = yield* queryContract<Cw20AllowanceResponse>(client, contractAddress, {
      allowance: {
        owner: ownerAddress,
        spender: spenderAddress
      }
    })

    return response.allowance
  })
