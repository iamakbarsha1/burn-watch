/**
 * Tailwind v4 was in package.json and `@import "tailwindcss"` was at the top of
 * globals.css, but this file did not exist — so the import compiled to nothing
 * and no utility class in the app had ever done anything. That is almost
 * certainly why every component was written with inline `style` objects.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

export default config
