import { Data } from "effect"
import type { Instruction } from "@unionlabs/sdk/ucs03"
import type { TokenRawDenom } from "$lib/schema/token"

/**
 * Defines the different steps in a transfer process
 */
export type TransferStep = Data.TaggedEnum<{
  Filling: {}
  ApprovalRequired: {
    readonly token: TokenRawDenom
    readonly requiredAmount: bigint
    readonly currentAllowance: bigint
  }
  SubmitInstruction: {
    readonly instruction: Instruction
  }
}>

// Create constructors for the steps
export const { Filling, ApprovalRequired, SubmitInstruction } = Data.taggedEnum<TransferStep>()

/**
 * Get a human-readable description for a transfer step
 */
export function getStepDescription(step: TransferStep): string {
  if (step._tag === "Filling") {
    return "Configure your transfer details"
  }
  if (step._tag === "ApprovalRequired") {
    return "Approve token spending"
  }
  if (step._tag === "SubmitInstruction") {
    return "Submit transfer to blockchain"
  }
  return "Transfer step"
}
