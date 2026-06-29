#![doc = "Binary for building odra schema."]
#![no_std]
#![cfg_attr(target_arch = "wasm32", no_main)]
#![allow(unused_imports, clippy::single_component_path_imports)]
use stakeholder_deposit;

#[cfg(not(target_arch = "wasm32"))]
fn main() {}