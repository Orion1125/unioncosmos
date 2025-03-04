import { Schema } from "effect"
import { ChainReference } from "$lib/schema/chain"
import { Hex } from "$lib/schema/hex"
import { PacketTrace } from "$lib/schema/packet-trace"
import { ConnectionId } from "$lib/schema/connection"
import { ChannelId } from "$lib/schema/channel"
import { TokenRawDenom, TokenRawAmount } from "$lib/schema/token"

export class TransferDetails extends Schema.Class<TransferDetails>("TransferDetails")({
  sender_canonical: Hex,
  source_chain: ChainReference,
  source_connection_id: ConnectionId,
  source_channel_id: ChannelId,
  packet_send_transaction_hash: Schema.String,
  receiver_canonical: Hex,
  destination_chain: ChainReference,
  destination_connection_id: ConnectionId,
  destination_channel_id: ChannelId,
  packet_send_timestamp: Schema.DateTimeUtc,
  packet_recv_timestamp: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  base_token: TokenRawDenom,
  base_amount: TokenRawAmount,
  quote_amount: TokenRawAmount,
  quote_token: TokenRawDenom,
  traces: Schema.Array(PacketTrace)
}) {}
