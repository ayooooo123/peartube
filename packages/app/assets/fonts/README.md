# Bundled fonts

Both families are licensed under the SIL Open Font License 1.1 (see the
`OFL-*.txt` files beside them). The relay console embeds the same Syne
ExtraBold face in `packages/cli/src/ui-font-syne.js`.

| File | Source | Instance |
|---|---|---|
| `Syne-ExtraBold.ttf`, `Syne-Bold.ttf` | `google/fonts` `ofl/syne/Syne[wght].ttf` | `wght=800`, `wght=700` |
| `JetBrainsMono-Regular.ttf`, `JetBrainsMono-Medium.ttf` | `google/fonts` `ofl/jetbrainsmono/JetBrainsMono[wght].ttf` | `wght=400`, `wght=500` |

Static instances are cut from the variable fonts with fontTools, because
React Native does not select weight axes from variable TTFs reliably:

```sh
curl -sfLo "Syne[wght].ttf" "https://github.com/google/fonts/raw/main/ofl/syne/Syne%5Bwght%5D.ttf"
curl -sfLo "JetBrainsMono[wght].ttf" "https://github.com/google/fonts/raw/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf"
uvx --from fonttools fonttools varLib.instancer "Syne[wght].ttf" wght=800 -o Syne-ExtraBold.ttf
uvx --from fonttools fonttools varLib.instancer "Syne[wght].ttf" wght=700 -o Syne-Bold.ttf
uvx --from fonttools fonttools varLib.instancer "JetBrainsMono[wght].ttf" wght=400 -o JetBrainsMono-Regular.ttf
uvx --from fonttools fonttools varLib.instancer "JetBrainsMono[wght].ttf" wght=500 -o JetBrainsMono-Medium.ttf
base64 -i Syne-ExtraBold.ttf | tr -d '\n'   # -> packages/cli/src/ui-font-syne.js
```
