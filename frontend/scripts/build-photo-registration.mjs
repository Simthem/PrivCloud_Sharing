import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import ts from "typescript"

const require = createRequire(import.meta.url)
const expected =
  "b873c8211421da7b9bf41ae157a923f05a46a0b8d3e5904c44c6f3ad6d39a1bd"

// Generic Embind marshalling, without generating JavaScript from strings.
// The WASM binary and OpenCV algorithms are not modified.
function cspCraftInvoker(name, types, classType, invoke, target, async) {
  if (async || types.length < 2) throw new Error("Unsupported OpenCV binding")
  const method = types[1] !== null && classType !== null
  const stack = usesDestructorStack(types)
  return createNamedFunction(name, function (...args) {
    if (args.length !== types.length - 2)
      throw new Error("Invalid OpenCV arguments")
    const destructors = stack ? [] : null
    const wired = [target]
    let value
    try {
      if (method) wired.push(types[1].toWireType(destructors, this))
      for (let index = 2; index < types.length; index++)
        wired.push(types[index].toWireType(destructors, args[index - 2]))
      value = invoke(...wired)
    } finally {
      if (stack) runDestructors(destructors)
      else
        for (let index = method ? 1 : 2; index < types.length; index++)
          if (
            types[index].destructorFunction !== null &&
            index - (method ? 0 : 1) < wired.length
          )
            types[index].destructorFunction(wired[index - (method ? 0 : 1)])
    }
    return types[0].isVoid ? undefined : types[0].fromWireType(value)
  })
}

function cspEmvalInvoker(count, pointer, kind) {
  const [resultType, ...types] = emval_lookupTypes(count, pointer)
  const caller = (handle, methodName, destructors, values) => {
    const args = types.map((type, index) =>
      type.readValueFromPointer(values + index * 8),
    )
    const object = kind === 3 ? null : Emval.toValue(handle)
    let result
    if (kind === 0) result = Reflect.apply(object, null, args)
    else if (kind === 1)
      result = Reflect.apply(
        object[getStringOrSymbol(methodName)],
        object,
        args,
      )
    else if (kind === 2) result = Reflect.construct(object, args)
    else if (kind === 3) result = args[0]
    else throw new Error("Unsupported OpenCV invocation")
    return resultType.isVoid
      ? undefined
      : emval_returnValue(
          resultType.toWireType.bind(resultType),
          destructors,
          result,
        )
  }
  return emval_addMethodCaller(createNamedFunction("methodCaller", caller))
}

export function cspOpenCv(bytes) {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expected,
    "Unexpected OpenCV bytes. Review the runtime adapter before updating.",
  )
  let source = bytes.toString("utf8")
  const begin = source.indexOf("function createJsInvoker(")
  const end = source.indexOf("var heap32VectorToArray=", begin)
  assert.ok(begin >= 0 && end > begin)
  source =
    source.slice(0, begin) +
    cspCraftInvoker
      .toString()
      .replace("cspCraftInvoker", "craftInvokerFunction") +
    source.slice(end)
  const emvalBegin = source.indexOf("var __emval_create_invoker=")
  const emvalEnd = source.indexOf(";var __emval_get_property=", emvalBegin)
  assert.ok(emvalBegin >= 0 && emvalEnd > emvalBegin)
  source =
    source.slice(0, emvalBegin) +
    cspEmvalInvoker
      .toString()
      .replace("cspEmvalInvoker", "__emval_create_invoker") +
    source.slice(emvalEnd)
  assert.doesNotMatch(source, /\b(?:new\s+)?Function\s*\(|\beval\s*\(/)
  return source
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  const destination = new URL("../public/forensic/", import.meta.url)
  await mkdir(destination, { recursive: true })
  await writeFile(
    new URL("opencv-csp.js", destination),
    cspOpenCv(await readFile(require.resolve("@techstark/opencv-js"))),
  )
  await writeFile(
    new URL("OPENCV_LICENSE.txt", destination),
    await readFile(
      new URL(
        "../LICENSE",
        pathToFileURL(require.resolve("@techstark/opencv-js")),
      ),
    ),
  )
  const core = await readFile(
    new URL("../src/utils/photoRegistrationCore.util.ts", import.meta.url),
    "utf8",
  )
  const compiled = ts.transpileModule(core, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
    reportDiagnostics: true,
  })
  assert.equal(compiled.diagnostics.length, 0)
  await writeFile(
    new URL("registration-core.mjs", destination),
    compiled.outputText,
  )
}
