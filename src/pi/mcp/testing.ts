import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"

/**
 * Fake ExtensionAPI for tests, reproducing the parts of pi's tool registry
 * the adapter relies on: same-name registration overwrites, names new to the
 * registry become active, excluded names never enter the registry, and
 * setActiveTools ignores unknown names. Event handlers and commands are
 * captured so tests can fire them.
 */
export function makeFakePi(excluded: string[] = [], builtins: string[] = ["read", "bash"]) {
  const registry = new Map<string, ToolDefinition<any>>()
  const known = (name: string) => registry.has(name) || builtins.includes(name)
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>()
  const commands = new Map<string, any>()
  let active: string[] = []
  const setActiveCalls: string[][] = []
  const pi = {
    registerTool: (t: ToolDefinition<any>) => {
      const isNew = !registry.has(t.name)
      registry.set(t.name, t)
      if (isNew && !excluded.includes(t.name)) active.push(t.name)
    },
    getAllTools: () =>
      [...registry.values()]
        .filter((t) => !excluded.includes(t.name))
        .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      setActiveCalls.push([...names])
      active = names.filter((n) => known(n) && !excluded.includes(n))
    },
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    registerShortcut: () => {},
    registerCommand: (name: string, options: any) => commands.set(name, options),
  } as unknown as ExtensionAPI

  const fire = async (event: string, payload: any, ctx: any) => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx)
  }

  return {
    pi,
    registry,
    commands,
    setActiveCalls,
    fire,
    active: () => [...active],
    setActive: (names: string[]) => (active = [...names]),
  }
}
