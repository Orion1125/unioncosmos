use enumorph::Enumorph;
use ibc_union_spec::ClientId;
use macros::model;
use unionlabs::ibc::core::client::height::Height;
use voyager_sdk::primitives::ChainId;

#[model]
#[derive(Enumorph)]
pub enum ModuleCall {
    FetchUpdate(FetchUpdate),
}

#[model]
pub struct FetchUpdate {
    pub from_height: Height,
    pub to_height: Height,
    pub counterparty_chain_id: ChainId,
    pub client_id: ClientId,
}
