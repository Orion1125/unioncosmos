import { Effect, Match, Option, pipe } from "effect";
import { fromHex, http } from "viem";
import {
  createViemPublicClient,
  ViemPublicClientSource,
  ViemPublicClientDestination,
  EvmChannelDestination
} from "@unionlabs/sdk/evm";
import {
  createCosmWasmClient,
  CosmWasmClientSource,
  CosmWasmClientDestination,
  CosmosChannelDestination
} from "@unionlabs/sdk/cosmos";
import {
  createEvmToCosmosFungibleAssetOrder,
  createEvmToEvmFungibleAssetOrder,
  createCosmosToEvmFungibleAssetOrder,
  createCosmosToCosmosFungibleAssetOrder
} from "@unionlabs/sdk/ucs03";
import { Batch } from "@unionlabs/sdk/ucs03/instruction";
import { Channel, Chain } from "@unionlabs/sdk/schema";
import { type TransferIntents } from "$lib/components/Transfer/transfer.svelte.ts";

export function createOrdersBatch(
  sourceChain: Chain,
  destinationChain: Chain,
  channel: Channel,
  ucs03address: string,
  intents: TransferIntents
) {
  return Effect.gen(function* () {
    // Validate required parameters.
    if (
      !sourceChain ||
      !destinationChain ||
      !channel ||
      !ucs03address ||
      !intents?.length
    ) {
      console.log("lukas: Missing required params or no intents → returning Option.none");
      return Option.none<Batch>();
    }
    console.log("lukas: createOrdersBatch invoked with:");
    console.log("lukas: sourceChain =>", sourceChain.display_name);
    console.log("lukas: destinationChain =>", destinationChain.display_name);
    console.log("lukas: channel =>", channel);
    console.log("lukas: ucs03address =>", ucs03address);
    console.log("lukas: first intent =>", intents[0]);

    // Extract the chain type strings.
    const source = sourceChain.rpc_type;
    const destination = destinationChain.rpc_type;
    console.log("lukas: source =>", source, ", destination =>", destination);

    // Set up client providers.
    const provideViemPublicClientSource = Effect.provideServiceEffect(
      ViemPublicClientSource,
      pipe(
        sourceChain.toViemChain(),
        Option.map(chain =>
          createViemPublicClient({
            chain,
            transport: http()
          })
        ),
        Effect.flatten,
        Effect.map(client => ({ client }))
      )
    );

    // For destination: only use ViemPublicClientDestination if destination is EVM.
    const provideViemPublicClientDestination =
      destination === "evm"
        ? Effect.provideServiceEffect(
          ViemPublicClientDestination,
          pipe(
            destinationChain.toViemChain(),
            Option.map(chain =>
              createViemPublicClient({
                chain,
                transport: http()
              })
            ),
            Effect.flatten,
            Effect.map(client => ({ client }))
          )
        )
        : Effect.succeed({});

    const provideCosmWasmClientSource = Effect.provideServiceEffect(
      CosmWasmClientSource,
      pipe(
        sourceChain.getRpcUrl("rpc"),
        Option.map(createCosmWasmClient),
        Effect.flatten,
        Effect.map(client => ({ client }))
      )
    );

    const provideCosmWasmClientDestination = Effect.provideServiceEffect(
      CosmWasmClientDestination,
      pipe(
        destinationChain.getRpcUrl("rpc"),
        Option.map(createCosmWasmClient),
        Effect.flatten,
        Effect.map(client => ({ client }))
      )
    );

    // Set up channel provider data.
    const evmChannelDestinationData = {
      ucs03address: channel.destination_port_id,
      channelId: channel.destination_channel_id
    };
    const cosmosChannelDestinationData = {
      ucs03address: fromHex(channel.destination_port_id, "string"),
      channelId: channel.destination_channel_id
    };
    console.log("lukas: EVM Channel =>", evmChannelDestinationData);
    console.log("lukas: Cosmos Channel =>", cosmosChannelDestinationData);

    const provideEvmChannelDestination = Effect.provideServiceEffect(
      EvmChannelDestination,
      Effect.succeed(evmChannelDestinationData)
    );
    const provideCosmosChannelDestination = Effect.provideServiceEffect(
      CosmosChannelDestination,
      Effect.succeed(cosmosChannelDestinationData)
    );

    console.log("lukas: Setting up batchEffect for order creation...");

    // Build the orders using a Match over [source, destination].
    const batchEffect = Effect.gen(function* () {
      console.log(`lukas: Using Match with [${source}, ${destination}]`);
      const orders = yield* Match.value([source, destination]).pipe(
        // EVM -> Cosmos: Create two orders if two intents exist.
        Match.when(["evm", "cosmos"], () => {
          console.log("lukas: Matched EVM -> Cosmos pattern", intents.value);
          return Effect.all([
            Effect.tap(createEvmToCosmosFungibleAssetOrder(intents[0]), order =>
              Effect.sync(() => console.log("lukas: First EVM->Cosmos order created", order))
            ),
            intents.length > 1
              ? Effect.tap(createEvmToCosmosFungibleAssetOrder(intents[1]), order =>
                Effect.sync(() => console.log("lukas: Second EVM->Cosmos order created", order))
              )
              : Effect.succeed(null)
          ]).pipe(
            Effect.tap(createdOrders =>
              Effect.sync(() => console.log("lukas: All EVM->Cosmos orders created", createdOrders))
            ),
            Effect.catchAll(error => {
              console.error("lukas: Error creating EVM->Cosmos orders", error);
              return Effect.fail(error);
            }),
            // Apply providers for this branch.
            provideCosmosChannelDestination,
            provideViemPublicClientSource,
            provideCosmWasmClientDestination
          );
        }),
        // EVM -> EVM: Create two orders.
        Match.when(["evm", "evm"], () => {
          console.log("lukas: Matched EVM -> EVM pattern");
          return Effect.all([
            Effect.tap(createEvmToEvmFungibleAssetOrder(intents[0]), order =>
              Effect.sync(() => console.log("lukas: EVM->EVM first order created", order))
            ),
            intents.length > 1
              ? Effect.tap(createEvmToEvmFungibleAssetOrder(intents[1]), order =>
                Effect.sync(() => console.log("lukas: EVM->EVM second order created", order))
              )
              : Effect.succeed(null)
          ]).pipe(
            Effect.tap(createdOrders =>
              Effect.sync(() => console.log("lukas: EVM->EVM orders created", createdOrders))
            ),
            Effect.catchAll(error => {
              console.error("lukas: Error creating EVM->EVM orders", error);
              return Effect.fail(error);
            }),
            provideViemPublicClientSource,
            provideViemPublicClientDestination,
            provideEvmChannelDestination
          );
        }),
        // Cosmos -> EVM: Create one order.
        Match.when(["cosmos", "evm"], () => {
          console.log("lukas: Matched Cosmos -> EVM pattern");
          // Wrap in Effect.all to maintain consistency with other branches
          return Effect.all([
            createCosmosToEvmFungibleAssetOrder(intents[0]).pipe(
              Effect.tap(order =>
                Effect.sync(() => console.log("lukas: (Cosmos->EVM) order created", order))
              )
            )
          ]).pipe(
            Effect.tap(createdOrders =>
              Effect.sync(() => console.log("lukas: All Cosmos->EVM orders created", createdOrders))
            ),
            Effect.catchAll(error => {
              console.error("lukas: Error creating Cosmos->EVM orders", error);
              return Effect.fail(error);
            }),
            provideCosmWasmClientSource,
            provideViemPublicClientDestination,
            provideEvmChannelDestination
          );
        }),
        // Cosmos -> Cosmos: Create one order.
        Match.when(["cosmos", "cosmos"], () => {
          console.log("lukas: Matched Cosmos -> Cosmos pattern");
          // Wrap in Effect.all to maintain consistency with other branches
          return Effect.all([
            createCosmosToCosmosFungibleAssetOrder(intents[0]).pipe(
              Effect.tap(order =>
                Effect.sync(() => console.log("lukas: (Cosmos->Cosmos) order created", order))
              )
            )
          ]).pipe(
            Effect.tap(createdOrders =>
              Effect.sync(() => console.log("lukas: All Cosmos->Cosmos orders created", createdOrders))
            ),
            Effect.catchAll(error => {
              console.error("lukas: Error creating Cosmos->Cosmos orders", error);
              return Effect.fail(error);
            }),
            provideCosmWasmClientSource,
            provideCosmWasmClientDestination,
            provideCosmosChannelDestination
          );
        }),
        Match.orElse(() => {
          console.warn(`lukas: Unsupported source->destination: ${source} -> ${destination}`);
          throw new Error(`Unsupported chain combo: ${source} -> ${destination}`);
        })
      );

      // Yield the resolved orders.
      console.log("lukas: Done creating orders =>", orders);

      // Filter null values (from optional second intents)
      const filteredOrders = orders.filter(order => order !== null);
      console.log("lukas: Filtered orders:", filteredOrders);

      const batch = new Batch({
        operand: filteredOrders
      });
      console.log("lukas: Created new Batch =>", batch);
      return batch;
    });

    console.log("lukas: About to run batchEffect...");
    const batchResult = yield* batchEffect;
    console.log("lukas: Batch created successfully:", batchResult);
    console.log("lukas: Finished batchEffect. Returning Option.some(batch).");
    return Option.some(batchResult);
  }).pipe(
    Effect.catchAll(error => {
      console.error("lukas: Top-level error in createOrdersBatch:", error);
      return Effect.succeed(Option.none<Batch>());
    })
  );
}