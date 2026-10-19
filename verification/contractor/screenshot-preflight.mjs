import sharp from "sharp"
import { screenshot, chromeTestArguments } from "./screenshot.mjs"

const pixels = await sharp({
  create: { width: 320, height: 256, channels: 4, background: "white" },
})
  .png()
  .toBuffer()
const result = await screenshot(pixels, 320, 256, { trustedSynthetic: true })
console.log(
  `Chrome synthetic capture ready: ${result.browser}, sandbox ${chromeTestArguments(true).length ? "CI container exception" : "enabled"}`,
)
