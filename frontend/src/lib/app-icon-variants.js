// The home-screen icons a phone can switch to (Settings → Look & Home → App icon). Plain data, no
// imports: scripts/app-icons.mjs draws every icon file from this list and the settings row lists
// the same ids, so the picker can never offer an icon the native projects do not have.
//
// `name` is the English key the row passes to t(). `ios` is the AppIcon set in the asset catalog
// (null: the primary icon) and `android` the activity-alias in AndroidManifest.xml. `art` is a
// hand-made SVG the script renders instead of the glyph; `bg`/`fg` are then just its main colours.
export const APP_ICON_VARIANTS = [
  { id: 'default', name: 'Original', bg: '#0A0B0D', fg: '#D0FF00', ios: null, android: 'IconDefault' },
  { id: 'light', name: 'Light', bg: '#ffffff', fg: '#4d6600', ios: 'AppIcon-Light', android: 'IconLight' },
  { id: 'mono', name: 'Mono', bg: '#0A0B0D', fg: '#f2f2f7', ios: 'AppIcon-Mono', android: 'IconMono' },
  { id: 'neon', name: 'Green', bg: '#D0FF00', fg: '#0A0B0D', ios: 'AppIcon-Neon', android: 'IconNeon' },
  { id: 'sky', name: 'Blue', bg: '#0a84ff', fg: '#ffffff', ios: 'AppIcon-Sky', android: 'IconSky' },
  { id: 'orange', name: 'Orange', bg: '#ff9f0a', fg: '#0A0B0D', ios: 'AppIcon-Orange', android: 'IconOrange' },
  { id: 'pink', name: 'Pink', bg: '#ff375f', fg: '#ffffff', ios: 'AppIcon-Pink', android: 'IconPink' },
  { id: 'violet', name: 'Purple', bg: '#bf5af2', fg: '#ffffff', ios: 'AppIcon-Violet', android: 'IconViolet' },
  // All year, Halloween theme or not: Rit "R" in pumpkin orange under a spooky night.
  { id: 'halloween', name: 'Halloween', bg: '#0d0517', fg: '#ff7a1a', art: 'resources/icons/halloween.svg', ios: 'AppIcon-Halloween', android: 'IconHalloween' },
  // Christmas seasonal edition: Rit "R" in Volt Lime with a Santa hat and snowflakes.
  { id: 'christmas', name: 'Christmas', bg: '#070b16', fg: '#D0FF00', art: 'resources/icons/christmas.svg', ios: 'AppIcon-Christmas', android: 'IconChristmas' },
]

export const APP_ICON_IDS = APP_ICON_VARIANTS.map(v => v.id)
