use core::str;

use alloy::{primitives::U256, sol_types::SolValue};
#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{
    instantiate2_address, to_json_binary, to_json_string, wasm_execute, Addr, Binary,
    CodeInfoResponse, Coin, CosmosMsg, Deps, DepsMut, Env, MessageInfo, QueryRequest, Reply,
    Response, StdError, StdResult, SubMsg, SubMsgResult, Uint128, Uint256, WasmMsg,
};
use ibc_union_msg::{
    module::IbcUnionMsg,
    msg::{MsgSendPacket, MsgWriteAcknowledgement},
};
use ibc_union_spec::types::Packet;
use ucs03_zkgm_token_minter_api::{
    LocalTokenMsg, Metadata, MetadataResponse, WrappedTokenMsg, DISPATCH_EVENT, DISPATCH_EVENT_ATTR,
};
use unionlabs::{
    ethereum::keccak256,
    primitives::{Bytes, H256},
};
use unionlabs_cosmwasm_upgradable::UpgradeMsg;

use crate::{
    com::{
        decode_fungible_asset, Ack, Batch, BatchAck, FungibleAssetOrder, FungibleAssetOrderAck,
        Instruction, Multiplex, ZkgmPacket, ACK_ERR_ONLY_MAKER, FILL_TYPE_MARKETMAKER,
        FILL_TYPE_PROTOCOL, INSTR_VERSION_0, INSTR_VERSION_1, OP_BATCH, OP_FUNGIBLE_ASSET_ORDER,
        OP_MULTIPLEX, OP_TAG, TAG_ACK_FAILURE, TAG_ACK_SUCCESS,
    },
    msg::{EurekaMsg, ExecuteMsg, InitMsg, PredictWrappedTokenResponse, QueryMsg},
    state::{
        CHANNEL_BALANCE, CONFIG, EXECUTING_PACKET, EXECUTION_ACK, HASH_TO_FOREIGN_TOKEN,
        TOKEN_MINTER, TOKEN_ORIGIN,
    },
    ContractError,
};

pub const PROTOCOL_VERSION: &str = "ucs03-zkgm-0";

pub const EXECUTE_REPLY_ID: u64 = 0x1337;
pub const TOKEN_INIT_REPLY_ID: u64 = 0xbeef;
pub const ESCROW_REPLY_ID: u64 = 0xcafe;

pub const ZKGM_TOKEN_MINTER_LABEL: &str = "zkgm-token-minter";

/// Instantiate `ucs03-zkgm`.
///
/// This will instantiate the minter contract with the provided [`TokenMinterInitMsg`][crate::msg::TokenMinterInitMsg]. The admin of the minter contract is set to `ucs03-zkgm`. All migrations for the minter will be threaded through the `ucs03-zkgm` migrate entrypoint.
pub fn init(deps: DepsMut, env: Env, msg: InitMsg) -> Result<Response, ContractError> {
    CONFIG.save(deps.storage, &msg.config)?;

    let salt = minter_salt();

    let minter_address = instantiate2_address(
        get_code_hash(deps.as_ref(), msg.config.token_minter_code_id)?.as_ref(),
        &deps.api.addr_canonicalize(env.contract.address.as_str())?,
        salt.as_bytes(),
    )
    .expect("valid instantiate2 address");

    TOKEN_MINTER.save(deps.storage, &deps.api.addr_humanize(&minter_address)?)?;

    let msg = WasmMsg::Instantiate2 {
        admin: Some(env.contract.address.to_string()),
        code_id: msg.config.token_minter_code_id,
        msg: to_json_binary(&msg.minter_init_msg)?,
        funds: vec![],
        label: ZKGM_TOKEN_MINTER_LABEL.to_string(),
        salt: salt.into_bytes().into(),
    };

    Ok(Response::new().add_submessage(SubMsg::reply_never(msg)))
}

/// The salt used to instantiate the token minter (using [instantiate2_address]).
pub fn minter_salt() -> String {
    format!("{PROTOCOL_VERSION}/{ZKGM_TOKEN_MINTER_LABEL}")
}

fn get_code_hash(deps: Deps, code_id: u64) -> StdResult<H256> {
    Ok(H256::new(
        *deps
            .querier
            .query::<CodeInfoResponse>(&QueryRequest::Wasm(cosmwasm_std::WasmQuery::CodeInfo {
                code_id,
            }))?
            .checksum
            .as_ref(),
    ))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::IbcUnionMsg(ibc_msg) => {
            if info.sender != CONFIG.load(deps.storage)?.ibc_host {
                return Err(ContractError::OnlyIBCHost);
            }

            match ibc_msg {
                IbcUnionMsg::OnChannelOpenInit { version, .. } => {
                    enforce_version(&version, None)?;
                    Ok(Response::default())
                }
                IbcUnionMsg::OnChannelOpenTry {
                    version,
                    counterparty_version,
                    ..
                } => {
                    enforce_version(&version, Some(&counterparty_version))?;
                    Ok(Response::default())
                }
                IbcUnionMsg::OnChannelOpenAck { .. } | IbcUnionMsg::OnChannelOpenConfirm { .. } => {
                    Ok(Response::default())
                }
                IbcUnionMsg::OnRecvPacket {
                    packet,
                    relayer,
                    relayer_msg,
                } => {
                    let relayer = deps.api.addr_validate(&relayer)?;
                    if EXECUTING_PACKET.exists(deps.storage) {
                        Err(ContractError::AlreadyExecuting)
                    } else {
                        EXECUTING_PACKET.save(deps.storage, &packet)?;
                        Ok(Response::default().add_submessage(SubMsg::reply_always(
                            wasm_execute(
                                env.contract.address,
                                &ExecuteMsg::ExecutePacket {
                                    packet,
                                    relayer,
                                    relayer_msg,
                                },
                                vec![],
                            )?,
                            EXECUTE_REPLY_ID,
                        )))
                    }
                }
                IbcUnionMsg::OnAcknowledgementPacket {
                    packet,
                    acknowledgement,
                    relayer,
                } => {
                    let relayer = deps.api.addr_validate(&relayer)?;
                    acknowledge_packet(deps, env, info, packet, relayer, acknowledgement)
                }
                IbcUnionMsg::OnTimeoutPacket { packet, relayer } => {
                    let relayer = deps.api.addr_validate(&relayer)?;
                    timeout_packet(deps, env, info, packet, relayer)
                }
                IbcUnionMsg::OnChannelCloseInit { .. }
                | IbcUnionMsg::OnChannelCloseConfirm { .. } => {
                    Err(StdError::generic_err("the show must go on").into())
                }
                x => Err(
                    StdError::generic_err(format!("not handled: {}", to_json_string(&x)?)).into(),
                ),
            }
        }
        ExecuteMsg::BatchExecute { msgs } => {
            if info.sender != env.contract.address {
                Err(ContractError::OnlySelf)
            } else {
                Ok(Response::default().add_messages(msgs))
            }
        }
        ExecuteMsg::ExecutePacket {
            packet,
            relayer,
            relayer_msg,
        } => {
            if info.sender != env.contract.address {
                Err(ContractError::OnlySelf)
            } else {
                execute_packet(deps, env, info, packet, relayer, relayer_msg)
            }
        }
        ExecuteMsg::Transfer {
            channel_id,
            receiver,
            base_token,
            base_amount,
            quote_token,
            quote_amount,
            timeout_height,
            timeout_timestamp,
            salt,
        } => transfer(
            deps,
            env,
            info,
            channel_id,
            receiver,
            base_token,
            base_amount,
            quote_token,
            quote_amount,
            timeout_height,
            timeout_timestamp,
            salt,
        ),
    }
}

fn enforce_version(version: &str, counterparty_version: Option<&str>) -> Result<(), ContractError> {
    if version != PROTOCOL_VERSION {
        return Err(ContractError::InvalidIbcVersion {
            version: version.to_string(),
        });
    }
    if let Some(version) = counterparty_version {
        if version != PROTOCOL_VERSION {
            return Err(ContractError::InvalidIbcVersion {
                version: version.to_string(),
            });
        }
    }
    Ok(())
}

fn timeout_packet(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    packet: Packet,
    relayer: Addr,
) -> Result<Response, ContractError> {
    let zkgm_packet = ZkgmPacket::abi_decode_params(&packet.data, true)?;
    timeout_internal(
        deps,
        env,
        info,
        packet,
        relayer,
        zkgm_packet.salt.into(),
        zkgm_packet.path,
        zkgm_packet.instruction,
    )
}

#[allow(clippy::too_many_arguments)]
fn timeout_internal(
    mut deps: DepsMut,
    env: Env,
    info: MessageInfo,
    packet: Packet,
    relayer: Addr,
    salt: H256,
    _path: alloy::primitives::U256,
    instruction: Instruction,
) -> Result<Response, ContractError> {
    match instruction.opcode {
        OP_FUNGIBLE_ASSET_ORDER => {
            if instruction.version > INSTR_VERSION_1 {
                return Err(ContractError::UnsupportedVersion {
                    version: instruction.version,
                });
            }
            let order = decode_fungible_asset(&instruction)?;
            refund(deps, packet.source_channel_id, order)
        }
        OP_BATCH => {
            if instruction.version > INSTR_VERSION_0 {
                return Err(ContractError::UnsupportedVersion {
                    version: instruction.version,
                });
            }
            let mut response = Response::new();
            let batch = Batch::abi_decode_params(&instruction.operand, true)?;
            for (i, instruction) in batch.instructions.into_iter().enumerate() {
                let sub_response = timeout_internal(
                    deps.branch(),
                    env.clone(),
                    info.clone(),
                    packet.clone(),
                    relayer.clone(),
                    keccak256(
                        (alloy::primitives::U256::try_from(i).unwrap(), salt.get()).abi_encode(),
                    ),
                    _path,
                    instruction,
                )?;
                response = response
                    .add_events(sub_response.events)
                    .add_attributes(sub_response.attributes)
                    .add_submessages(sub_response.messages)
            }
            Ok(response)
        }
        OP_MULTIPLEX => {
            if instruction.version > INSTR_VERSION_0 {
                return Err(ContractError::UnsupportedVersion {
                    version: instruction.version,
                });
            }
            let multiplex = Multiplex::abi_decode_params(&instruction.operand, true)?;
            if !multiplex.eureka {
                // TODO: implement when execute is implemented
                Err(ContractError::Unimplemented)
            } else {
                Ok(Response::new())
            }
        }
        OP_TAG => {
            // The tag instruction is solely present for indexing purpose.
            // The protocol consider it as a noop.
            Ok(Response::new())
        }
        _ => Err(ContractError::UnknownOpcode {
            opcode: instruction.opcode,
        }),
    }
}

fn acknowledge_packet(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    packet: Packet,
    relayer: Addr,
    ack: Bytes,
) -> Result<Response, ContractError> {
    let zkgm_packet = ZkgmPacket::abi_decode_params(&packet.data, true)?;
    let ack = Ack::abi_decode_params(&ack, true)?;
    acknowledge_internal(
        deps,
        env,
        info,
        packet,
        relayer,
        zkgm_packet.salt.into(),
        zkgm_packet.path,
        zkgm_packet.instruction,
        ack.tag == TAG_ACK_SUCCESS,
        Vec::from(ack.inner_ack).into(),
    )
}

#[allow(clippy::too_many_arguments)]
fn acknowledge_internal(
    mut deps: DepsMut,
    env: Env,
    info: MessageInfo,
    packet: Packet,
    relayer: Addr,
    salt: H256,
    path: alloy::primitives::U256,
    instruction: Instruction,
    successful: bool,
    ack: Bytes,
) -> Result<Response, ContractError> {
    match instruction.opcode {
        OP_FUNGIBLE_ASSET_ORDER => {
            if instruction.version > INSTR_VERSION_1 {
                return Err(ContractError::UnsupportedVersion {
                    version: instruction.version,
                });
            }
            let order = decode_fungible_asset(&instruction)?;
            let order_ack = if successful {
                Some(FungibleAssetOrderAck::abi_decode_params(&ack, true)?)
            } else {
                None
            };
            acknowledge_fungible_asset_order(
                deps, env, info, packet, relayer, salt, path, order, order_ack,
            )
        }
        OP_BATCH => {
            if instruction.version > INSTR_VERSION_0 {
                return Err(ContractError::UnsupportedVersion {
                    version: instruction.version,
                });
            }
            let mut response = Response::new();
            let batch = Batch::abi_decode_params(&instruction.operand, true)?;
            let batch_ack = if successful {
                Some(BatchAck::abi_decode_params(&ack, true)?)
            } else {
                None
            };
            for (i, instruction) in batch.instructions.into_iter().enumerate() {
                let sub_response = acknowledge_internal(
                    deps.branch(),
                    env.clone(),
                    info.clone(),
                    packet.clone(),
                    relayer.clone(),
                    keccak256(
                        (alloy::primitives::U256::try_from(i).unwrap(), salt.get()).abi_encode(),
                    ),
                    path,
                    instruction,
                    successful,
                    batch_ack
                        .as_ref()
                        .map(|batch_ack| Vec::from(batch_ack.acknowledgements[i].clone()).into())
                        .unwrap_or_default(),
                )?;
                response = response
                    .add_attributes(sub_response.attributes)
                    .add_events(sub_response.events)
                    .add_submessages(sub_response.messages);
            }
            Ok(response)
        }
        OP_MULTIPLEX => {
            if instruction.version > INSTR_VERSION_0 {
                return Err(ContractError::UnsupportedVersion {
                    version: instruction.version,
                });
            }
            let multiplex = Multiplex::abi_decode_params(&instruction.operand, true)?;
            if !multiplex.eureka {
                // TODO: implement when execute is implemented
                Err(ContractError::Unimplemented)
            } else {
                Ok(Response::new())
            }
        }
        OP_TAG => {
            // The tag instruction is solely present for indexing purpose.
            // The protocol consider it as a noop.
            Ok(Response::new())
        }
        _ => Err(ContractError::UnknownOpcode {
            opcode: instruction.opcode,
        }),
    }
}

fn refund(
    deps: DepsMut,
    source_channel: u32,
    order: FungibleAssetOrder,
) -> Result<Response, ContractError> {
    // 1. Native minter + sent native tokens: correct
    // 2. Cw20 minter + sent native tokens:
    let sender = deps
        .api
        .addr_validate(str::from_utf8(&order.sender).map_err(|_| ContractError::InvalidSender)?)
        .map_err(|_| ContractError::UnableToValidateSender)?;
    let minter = TOKEN_MINTER.load(deps.storage)?;
    let base_token = order.base_token;
    let base_amount =
        u128::try_from(order.base_amount).map_err(|_| ContractError::AmountOverflow)?;
    let base_denom =
        String::from_utf8(base_token.to_vec()).map_err(|_| ContractError::InvalidBaseToken)?;
    let mut messages = Vec::<CosmosMsg>::new();
    // TODO: handle forward path
    if order.base_token_path == source_channel.try_into().unwrap() {
        messages.push(make_wasm_msg(
            WrappedTokenMsg::MintTokens {
                denom: base_denom,
                amount: base_amount.into(),
                mint_to_address: sender.into_string(),
            },
            minter,
            vec![],
        )?);
    } else {
        messages.push(make_wasm_msg(
            LocalTokenMsg::Unescrow {
                denom: base_denom,
                recipient: sender.into_string(),
                amount: base_amount.into(),
            },
            minter,
            vec![],
        )?);
    }
    Ok(Response::new().add_messages(messages))
}

#[allow(clippy::too_many_arguments)]
fn acknowledge_fungible_asset_order(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    packet: Packet,
    _relayer: Addr,
    _salt: H256,
    _path: alloy::primitives::U256,
    order: FungibleAssetOrder,
    order_ack: Option<FungibleAssetOrderAck>,
) -> Result<Response, ContractError> {
    match order_ack {
        Some(successful_ack) => {
            let mut messages = Vec::<CosmosMsg>::new();
            match successful_ack.fill_type {
                FILL_TYPE_PROTOCOL => {
                    // Protocol filled, fee was paid on destination to the relayer.
                }
                FILL_TYPE_MARKETMAKER => {
                    // A market maker filled, we pay (unescrow|mint) with the base asset.
                    let base_amount = u128::try_from(order.base_amount)
                        .map_err(|_| ContractError::AmountOverflow)?;
                    let market_maker = deps
                        .api
                        .addr_validate(
                            str::from_utf8(successful_ack.market_maker.as_ref())
                                .map_err(|_| ContractError::InvalidReceiver)?,
                        )
                        .map_err(|_| ContractError::UnableToValidateMarketMaker)?;
                    let minter = TOKEN_MINTER.load(deps.storage)?;
                    let base_denom = order.base_token;
                    let base_denom = String::from_utf8(base_denom.to_vec())
                        .map_err(|_| ContractError::InvalidBaseToken)?;
                    // TODO: handle forward path
                    if order.base_token_path == packet.source_channel_id.try_into().unwrap() {
                        messages.push(make_wasm_msg(
                            WrappedTokenMsg::MintTokens {
                                denom: base_denom,
                                amount: base_amount.into(),
                                mint_to_address: market_maker.into_string(),
                            },
                            minter,
                            vec![],
                        )?);
                    } else {
                        messages.push(make_wasm_msg(
                            LocalTokenMsg::Unescrow {
                                denom: base_denom,
                                recipient: market_maker.into_string(),
                                amount: base_amount.into(),
                            },
                            minter,
                            vec![],
                        )?);
                    }
                }
                _ => return Err(StdError::generic_err("unknown fill_type, impossible?").into()),
            }
            Ok(Response::new().add_messages(messages))
        }
        // Transfer failed, refund
        None => refund(deps, packet.source_channel_id, order),
    }
}

fn execute_packet(
    mut deps: DepsMut,
    env: Env,
    info: MessageInfo,
    packet: Packet,
    relayer: Addr,
    relayer_msg: Bytes,
) -> Result<Response, ContractError> {
    let zkgm_packet = ZkgmPacket::abi_decode_params(&packet.data, true)?;
    let (ack, response) = execute_internal(
        deps.branch(),
        env,
        info,
        packet,
        relayer,
        relayer_msg,
        zkgm_packet.salt.into(),
        zkgm_packet.path,
        zkgm_packet.instruction,
    )?;
    EXECUTION_ACK.save(deps.storage, &ack)?;
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
fn execute_internal(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    packet: Packet,
    relayer: Addr,
    relayer_msg: Bytes,
    salt: H256,
    path: alloy::primitives::U256,
    instruction: Instruction,
) -> Result<(Bytes, Response), ContractError> {
    match instruction.opcode {
        OP_FUNGIBLE_ASSET_ORDER => {
            if instruction.version > INSTR_VERSION_1 {
                return Err(ContractError::UnsupportedVersion {
                    version: instruction.version,
                });
            }
            let order = decode_fungible_asset(&instruction)?;
            execute_fungible_asset_order(
                deps,
                env,
                info,
                packet,
                relayer,
                relayer_msg,
                salt,
                path,
                order,
            )
        }
        OP_BATCH => {
            if instruction.version > INSTR_VERSION_0 {
                return Err(ContractError::UnsupportedVersion {
                    version: instruction.version,
                });
            }
            let batch = Batch::abi_decode_params(&instruction.operand, true)?;
            execute_batch(
                deps,
                env,
                info,
                packet,
                relayer,
                relayer_msg,
                salt,
                path,
                batch,
            )
        }
        OP_MULTIPLEX => {
            if instruction.version > INSTR_VERSION_0 {
                return Err(ContractError::UnsupportedVersion {
                    version: instruction.version,
                });
            }
            let multiplex = Multiplex::abi_decode_params(&instruction.operand, true)?;
            execute_multiplex(
                deps,
                env,
                info,
                packet,
                relayer,
                relayer_msg,
                salt,
                path,
                multiplex,
            )
        }
        OP_TAG => {
            // The tag instruction is solely present for indexing purpose.
            // The protocol consider it as a noop.
            Ok((TAG_ACK_SUCCESS.abi_encode().into(), Response::new()))
        }
        _ => Err(ContractError::UnknownOpcode {
            opcode: instruction.opcode,
        }),
    }
}

fn query_predict_wrapped_token(
    deps: Deps,
    minter: &Addr,
    path: U256,
    channel: u32,
    token: Bytes,
) -> StdResult<String> {
    Ok(deps
        .querier
        .query::<ucs03_zkgm_token_minter_api::PredictWrappedTokenResponse>(&QueryRequest::Wasm(
            cosmwasm_std::WasmQuery::Smart {
                contract_addr: minter.to_string(),
                msg: to_json_binary(
                    &ucs03_zkgm_token_minter_api::QueryMsg::PredictWrappedToken {
                        path: path.to_string(),
                        channel,
                        token: Binary::new(token.to_vec()),
                    },
                )?,
            },
        ))?
        .wrapped_token)
}

// fn predict_wrapped_denom(path: alloy::primitives::U256, channel: u32, token: Bytes) -> String {
//     // TokenFactory denom name limit
//     const MAX_DENOM_LENGTH: usize = 44;

//     let token_hash = keccak256(
//         [
//             path.to_be_bytes_vec().as_ref(),
//             channel.to_be_bytes().as_ref(),
//             &token,
//         ]
//         .concat(),
//     )
//     .get()
//     .to_base58();

//     // https://en.wikipedia.org/wiki/Binary-to-text_encoding
//     // Luckily, base58 encoding has ~0.73 efficiency:
//     // (1 / 0.73) * 32 = 43.8356164384
//     // TokenFactory denom name limit
//     assert!(token_hash.len() <= MAX_DENOM_LENGTH);

//     token_hash.to_string()
// }

#[allow(clippy::too_many_arguments)]
fn execute_multiplex(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    packet: Packet,
    _relayer: Addr,
    _relayer_msg: Bytes,
    _salt: H256,
    _path: alloy::primitives::U256,
    multiplex: Multiplex,
) -> Result<(Bytes, Response), ContractError> {
    let contract_address = deps
        .api
        .addr_validate(
            str::from_utf8(&multiplex.contract_address)
                .map_err(|_| ContractError::InvalidContractAddress)?,
        )
        .map_err(|_| ContractError::UnableToValidateMultiplexTarget)?;
    if multiplex.eureka {
        Ok((
            TAG_ACK_SUCCESS.abi_encode().into(),
            Response::new().add_message(wasm_execute(
                contract_address,
                &EurekaMsg::OnZkgm {
                    channel_id: packet.destination_channel_id,
                    sender: multiplex.sender.to_vec().into(),
                    message: multiplex.contract_calldata.to_vec().into(),
                },
                vec![],
            )?),
        ))
    } else {
        // TODO: implement non eureka multiplexing, add a new msg `WriteAck` by
        // maintaining the hashing from packet to ack or thread the ack back
        // from the events directly? Beware we'll need to use submessage+reply
        // for execute_batch when implementing this as we need the ack to yield
        // the batch ack
        Err(ContractError::Unimplemented)
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_batch(
    mut deps: DepsMut,
    env: Env,
    info: MessageInfo,
    packet: Packet,
    relayer: Addr,
    relayer_msg: Bytes,
    salt: H256,
    path: alloy::primitives::U256,
    batch: Batch,
) -> Result<(Bytes, Response), ContractError> {
    let mut response = Response::new();
    let mut acks = Vec::<Bytes>::with_capacity(batch.instructions.len());
    for (i, instruction) in batch.instructions.into_iter().enumerate() {
        let (ack, sub_response) = execute_internal(
            deps.branch(),
            env.clone(),
            info.clone(),
            packet.clone(),
            relayer.clone(),
            relayer_msg.clone(),
            keccak256((alloy::primitives::U256::try_from(i).unwrap(), salt.get()).abi_encode()),
            path,
            instruction,
        )?;
        response = response
            .add_attributes(sub_response.attributes)
            .add_events(sub_response.events)
            .add_submessages(sub_response.messages);
        acks.push(ack);
    }
    Ok((
        BatchAck {
            acknowledgements: acks.into_iter().map(Into::into).collect(),
        }
        .abi_encode_params()
        .into(),
        response,
    ))
}

#[allow(clippy::too_many_arguments)]
fn execute_fungible_asset_order(
    deps: DepsMut,
    _: Env,
    _info: MessageInfo,
    packet: Packet,
    relayer: Addr,
    _relayer_msg: Bytes,
    _salt: H256,
    path: U256,
    order: FungibleAssetOrder,
) -> Result<(Bytes, Response), ContractError> {
    if order.quote_amount > order.base_amount {
        return Ok((ACK_ERR_ONLY_MAKER.into(), Response::new()));
    }

    let minter = TOKEN_MINTER.load(deps.storage)?;
    let wrapped_denom = query_predict_wrapped_token(
        deps.as_ref(),
        &minter,
        path,
        packet.destination_channel_id,
        Vec::from(order.base_token.clone()).into(),
    )?;
    let quote_amount =
        u128::try_from(order.quote_amount).map_err(|_| ContractError::AmountOverflow)?;
    let fee_amount = order.base_amount - order.quote_amount;
    let fee_amount = u128::try_from(fee_amount).map_err(|_| ContractError::AmountOverflow)?;
    let receiver = deps
        .api
        .addr_validate(
            str::from_utf8(order.receiver.as_ref()).map_err(|_| ContractError::InvalidReceiver)?,
        )
        .map_err(|_| ContractError::UnableToValidateReceiver)?;
    let mut messages = Vec::<SubMsg>::new();
    if order.quote_token.as_ref() == wrapped_denom.as_bytes() {
        // TODO: handle forwarding path
        if !HASH_TO_FOREIGN_TOKEN.has(deps.storage, wrapped_denom.clone()) {
            HASH_TO_FOREIGN_TOKEN.save(
                deps.storage,
                wrapped_denom.clone(),
                &Vec::from(order.base_token.clone()).into(),
            )?;
            messages.push(SubMsg::new(make_wasm_msg(
                WrappedTokenMsg::CreateDenom {
                    subdenom: wrapped_denom.clone(),
                    metadata: Metadata {
                        name: order.base_token_name,
                        symbol: order.base_token_symbol,
                        decimals: order.base_token_decimals,
                    },
                    path: path.to_be_bytes_vec().into(),
                    channel: packet.destination_channel_id,
                    token: Vec::from(order.base_token.clone()).into(),
                },
                &minter,
                vec![],
            )?));
            TOKEN_ORIGIN.save(
                deps.storage,
                wrapped_denom.clone(),
                &Uint256::from_u128(packet.destination_channel_id as _),
            )?;
        };
        messages.push(SubMsg::new(make_wasm_msg(
            WrappedTokenMsg::MintTokens {
                denom: wrapped_denom.clone(),
                amount: quote_amount.into(),
                mint_to_address: receiver.into_string(),
            },
            &minter,
            vec![],
        )?));
        if fee_amount > 0 {
            messages.push(SubMsg::new(make_wasm_msg(
                WrappedTokenMsg::MintTokens {
                    denom: wrapped_denom,
                    amount: fee_amount.into(),
                    mint_to_address: relayer.into_string(),
                },
                &minter,
                vec![],
            )?));
        }
    } else if order.base_token_path == alloy::primitives::U256::from(packet.source_channel_id) {
        let quote_token = String::from_utf8(Vec::from(order.quote_token))
            .map_err(|_| ContractError::InvalidQuoteToken)?;
        CHANNEL_BALANCE.update(
            deps.storage,
            (packet.destination_channel_id, quote_token.clone()),
            |balance| match balance {
                Some(value) => value
                    .checked_sub(quote_amount.into())
                    .map_err(|_| ContractError::InvalidChannelBalance),
                None => Err(ContractError::InvalidChannelBalance),
            },
        )?;
        messages.push(SubMsg::new(make_wasm_msg(
            LocalTokenMsg::Unescrow {
                denom: quote_token.clone(),
                recipient: receiver.into_string(),
                amount: quote_amount.into(),
            },
            &minter,
            vec![],
        )?));
        if fee_amount > 0 {
            messages.push(SubMsg::new(make_wasm_msg(
                LocalTokenMsg::Unescrow {
                    denom: quote_token.clone(),
                    recipient: relayer.into_string(),
                    amount: quote_amount.into(),
                },
                minter,
                vec![],
            )?));
        }
    } else {
        return Ok((ACK_ERR_ONLY_MAKER.into(), Response::new()));
    };
    Ok((
        FungibleAssetOrderAck {
            fill_type: FILL_TYPE_PROTOCOL,
            market_maker: Default::default(),
        }
        .abi_encode_params()
        .into(),
        Response::new().add_submessages(messages),
    ))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn reply(deps: DepsMut, _env: Env, reply: Reply) -> Result<Response, ContractError> {
    match reply.id {
        ESCROW_REPLY_ID => {
            let Some(dispatch) = reply
                .result
                .into_result()
                .expect("only if success")
                .events
                .into_iter()
                .find(|e| e.ty == format!("wasm-{DISPATCH_EVENT}"))
            else {
                return Ok(Response::new());
            };

            let Some(attr) = dispatch
                .attributes
                .into_iter()
                .find(|a| a.key == DISPATCH_EVENT_ATTR)
            else {
                return Ok(Response::new());
            };

            match serde_json_wasm::from_str::<Vec<WasmMsg>>(&attr.value) {
                Ok(msgs) => Ok(Response::new().add_messages(msgs)),
                Err(_) => Ok(Response::new()),
            }
        }
        EXECUTE_REPLY_ID => {
            let ibc_host = CONFIG.load(deps.storage)?.ibc_host;
            let packet = EXECUTING_PACKET.load(deps.storage)?;
            EXECUTING_PACKET.remove(deps.storage);
            match reply.result {
                SubMsgResult::Ok(_) => {
                    // If the execution succedeed ack is guaranteed to exist.
                    let execution_ack = EXECUTION_ACK.load(deps.storage)?;
                    EXECUTION_ACK.remove(deps.storage);
                    match execution_ack {
                        // Specific value when the execution must be replayed by a MM. No
                        // side effects were executed. We break the TX for MMs to be able to
                        // replay the packet.
                        ack if ack.as_ref() == ACK_ERR_ONLY_MAKER => Err(ContractError::OnlyMaker),
                        ack if !ack.is_empty() => {
                            let zkgm_ack = Ack {
                                tag: TAG_ACK_SUCCESS,
                                inner_ack: Vec::from(ack).into(),
                            }
                            .abi_encode_params();
                            Ok(Response::new().add_message(wasm_execute(
                                &ibc_host,
                                &ibc_union_msg::msg::ExecuteMsg::WriteAcknowledgement(
                                    MsgWriteAcknowledgement {
                                        channel_id: packet.destination_channel_id,
                                        packet,
                                        acknowledgement: zkgm_ack.into(),
                                    },
                                ),
                                vec![],
                            )?))
                        }
                        // Async acknowledgement, we don't write anything
                        _ => Ok(Response::new()),
                    }
                }
                // Something went horribly wrong.
                SubMsgResult::Err(e) => {
                    let zkgm_ack = Ack {
                        tag: TAG_ACK_FAILURE,
                        inner_ack: Default::default(),
                    }
                    .abi_encode_params();
                    Ok(Response::new()
                        .add_attribute("fatal_error", to_json_string(&e)?)
                        .add_message(wasm_execute(
                            &ibc_host,
                            &ibc_union_msg::msg::ExecuteMsg::WriteAcknowledgement(
                                MsgWriteAcknowledgement {
                                    channel_id: packet.destination_channel_id,
                                    packet,
                                    acknowledgement: zkgm_ack.into(),
                                },
                            ),
                            vec![],
                        )?))
                }
            }
        }
        _ => Err(ContractError::UnknownReply { id: reply.id }),
    }
}

#[allow(clippy::too_many_arguments)]
fn transfer(
    deps: DepsMut,
    _: Env,
    info: MessageInfo,
    channel_id: u32,
    receiver: Bytes,
    base_token: String,
    base_amount: Uint128,
    quote_token: Bytes,
    quote_amount: Uint256,
    timeout_height: u64,
    timeout_timestamp: u64,
    salt: H256,
) -> Result<Response, ContractError> {
    // NOTE(aeryz): We don't check whether the funds are provided here. We check it in the
    // minter because cw20 token minter doesn't require funds to be given in the native form.
    if base_amount.is_zero() {
        return Err(ContractError::InvalidAmount);
    }
    let minter = TOKEN_MINTER.load(deps.storage)?;
    // If the origin exists, the preimage exists
    let unwrapped_asset = HASH_TO_FOREIGN_TOKEN.may_load(deps.storage, base_token.clone())?;
    let mut messages = Vec::<SubMsg>::new();
    // TODO: handle forward path
    let mut origin = TOKEN_ORIGIN.may_load(deps.storage, base_token.clone())?;
    match origin {
        // Burn as we are going to unescrow on the counterparty
        Some(path)
            if path == Uint256::from(channel_id)
                && unwrapped_asset == Some(quote_token.clone()) =>
        {
            messages.push(SubMsg::reply_on_success(
                make_wasm_msg(
                    WrappedTokenMsg::BurnTokens {
                        denom: base_token.clone(),
                        amount: base_amount,
                        burn_from_address: minter.to_string(),
                        sender: info.sender.clone(),
                    },
                    &minter,
                    info.funds,
                )?,
                ESCROW_REPLY_ID,
            ))
        }
        // Escrow and update the balance, the counterparty will mint the token
        _ => {
            origin = None;
            messages.push(SubMsg::reply_on_success(
                make_wasm_msg(
                    LocalTokenMsg::Escrow {
                        from: info.sender.to_string(),
                        denom: base_token.clone(),
                        recipient: minter.to_string(),
                        amount: base_amount,
                    },
                    &minter,
                    info.funds,
                )?,
                ESCROW_REPLY_ID,
            ));
            CHANNEL_BALANCE.update(deps.storage, (channel_id, base_token.clone()), |balance| {
                match balance {
                    Some(value) => value
                        .checked_add(base_amount.into())
                        .map_err(|_| ContractError::InvalidChannelBalance),
                    None => Ok(base_amount.into()),
                }
            })?;
        }
    };
    let MetadataResponse {
        name: base_token_name,
        symbol: base_token_symbol,
        decimals: base_token_decimals,
    } = deps.querier.query::<MetadataResponse>(&QueryRequest::Wasm(
        cosmwasm_std::WasmQuery::Smart {
            contract_addr: minter.to_string(),
            msg: to_json_binary(&ucs03_zkgm_token_minter_api::QueryMsg::Metadata {
                denom: base_token.clone(),
            })?,
        },
    ))?;
    let config = CONFIG.load(deps.storage)?;
    messages.push(SubMsg::new(wasm_execute(
        &config.ibc_host,
        &ibc_union_msg::msg::ExecuteMsg::PacketSend(MsgSendPacket {
            source_channel: channel_id,
            timeout_height,
            timeout_timestamp,
            data: ZkgmPacket {
                salt: salt.into(),
                path: alloy::primitives::U256::ZERO,
                instruction: Instruction {
                    version: INSTR_VERSION_1,
                    opcode: OP_FUNGIBLE_ASSET_ORDER,
                    operand: FungibleAssetOrder {
                        sender: info.sender.as_bytes().to_vec().into(),
                        receiver: Vec::from(receiver).into(),
                        base_token: base_token.as_bytes().to_vec().into(),
                        base_amount: base_amount.u128().try_into().expect("u256>u128"),
                        base_token_symbol,
                        base_token_name,
                        base_token_decimals,
                        base_token_path: origin
                            .map(|x| alloy::primitives::U256::from_be_bytes(x.to_be_bytes()))
                            .unwrap_or(alloy::primitives::U256::ZERO),
                        quote_token: Vec::from(quote_token).into(),
                        quote_amount: alloy::primitives::U256::from_be_bytes(
                            quote_amount.to_be_bytes(),
                        ),
                    }
                    .abi_encode_params()
                    .into(),
                },
            }
            .abi_encode_params()
            .into(),
        }),
        vec![],
    )?));
    Ok(Response::new().add_submessages(messages))
}

#[cosmwasm_schema::cw_serde]
pub struct TokenMinterMigration {
    // code id of the new token minter
    new_code_id: u64,
    // migrate message json that will directly be passed to migrate call
    // it will be the same as the `to_json_binary(&msg)`'s output
    msg: Binary,
}

#[cosmwasm_schema::cw_serde]
pub struct MigrateMsg {
    // Provide `token_minter_migration` to also migrate the token minter
    token_minter_migration: Option<TokenMinterMigration>,
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(_: DepsMut, _: Env, _: MessageInfo, _: ()) -> StdResult<Response> {
    panic!("this contract cannot be instantiated directly, but must be migrated from an existing instantiated contract.");
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn migrate(
    deps: DepsMut,
    env: Env,
    msg: UpgradeMsg<InitMsg, MigrateMsg>,
) -> Result<Response, ContractError> {
    msg.run(
        deps,
        |deps, init_msg| {
            let res = init(deps, env, init_msg)?;

            Ok((res, None))
        },
        |deps, migrate_msg, _current_version| {
            if let Some(token_minter_migration) = migrate_msg.token_minter_migration {
                let token_minter = TOKEN_MINTER.load(deps.storage)?;
                Ok((
                    Response::default().add_message(WasmMsg::Migrate {
                        contract_addr: token_minter.to_string(),
                        new_code_id: token_minter_migration.new_code_id,
                        msg: token_minter_migration.msg,
                    }),
                    None,
                ))
            } else {
                Ok((Response::default(), None))
            }
        },
    )
}

fn make_wasm_msg(
    msg: impl Into<ucs03_zkgm_token_minter_api::ExecuteMsg>,
    minter: impl Into<String>,
    funds: Vec<Coin>,
) -> StdResult<CosmosMsg> {
    let msg = msg.into();
    Ok(CosmosMsg::Wasm(wasm_execute(minter, &msg, funds)?))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _: Env, msg: QueryMsg) -> Result<Binary, ContractError> {
    match msg {
        QueryMsg::PredictWrappedToken {
            path,
            channel,
            token,
        } => {
            let minter = TOKEN_MINTER.load(deps.storage)?;
            let token = query_predict_wrapped_token(
                deps,
                &minter,
                path.parse().map_err(ContractError::InvalidPath)?,
                channel,
                token,
            )?;
            Ok(to_json_binary(&PredictWrappedTokenResponse {
                wrapped_token: token.as_bytes().into(),
            })?)
        }
    }
}
