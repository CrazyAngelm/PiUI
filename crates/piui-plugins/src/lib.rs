//! PiUI plugin package format, manifest versions 1 and 2 (ADR-032).
//!
//! This crate is the host authority for `piui-plugin.json` and whole plugin
//! packages: the manifest schema and semantic rules, safe package reading
//! from a folder or a `.zip`, the package code hash that trust binds to,
//! declarative settings and node configuration fields, theme tokens, and the
//! policy the plugin protocol serves panels with. It never runs plugin code:
//! backends are started by the host supervisor
//! (`piui_runtime::plugin_backend`) only after the user's trust decision.

pub mod csp;
pub mod fields;
pub mod manifest;
pub mod package;
pub mod semver;
pub mod theme;
pub mod zip;

pub use fields::{Field, FieldKind, ValueIssue, carry_values, resolve_values};
pub use manifest::{
    Appearance, CommandContribution, CommandSurface, KeybindingContribution, MANIFEST_FILE,
    NodeTypeContribution, PanelContribution, Permission, PluginManifest, Problem, ProblemCode,
    RendererContribution, StatusItemContribution, ThemeContribution, ValidatedManifest,
    parse_manifest,
};
pub use package::{
    PackageFile, ValidatedPackage, code_hash, load_archive, load_folder, resolve_inside,
    validate_files, write_package,
};

#[cfg(test)]
mod tests;
