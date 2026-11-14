# Paper style

An entirely declarative manifest v3 plugin. **Paper** combines light colors,
rounded controls, plain ornaments and the system UI font. **Terminal** uses
dark colors, square controls, slanted ornaments and the existing monospace
font. There is no backend, panel, downloaded font or executable contribution.

Validate with `pnpm plugin:check examples/plugins/paper-style`. Install from
this folder through Settings → Plugins, then select Paper or Terminal under
Settings → General → Plugin theme. Disabling/removing the plugin restores
the current Nano/Chaos style. Safe mode activates neither style.

The optional `style` fields use only the presets documented in
`docs/PLUGINS.md`; unknown fields, CSS strings and unsupported enum values
fail validation before installation. Existing v1/v2 palettes remain valid.
