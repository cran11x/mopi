// litesvm 0.8.0's native binding (litesvm-linux-x64-gnu) leaves V8 in a state
// where the next garbage collection after any transaction containing a CPI
// (the ATA program creating an account, Token-2022 Reallocate, …) aborts the
// process:
//
//   terminate called after throwing an instance of 'std::bad_alloc'
//   #10 std::_Hashtable<AllocationSite…>::_M_rehash_aux
//   #11 v8::internal::PretenuringHandler::ProcessPretenuringFeedback
//   #12 v8::internal::Heap::PerformGarbageCollection
//
// (gdb backtrace, Node 22.22). Disabling allocation-site pretenuring — a pure
// V8 heap optimization with no effect on program behaviour — avoids that code
// path entirely; with it, hundreds of CPI transactions plus forced GCs run and
// exit cleanly. NODE_OPTIONS can't carry this V8 flag, so it is set at runtime,
// before any LiteSVM instance exists. Import this module before 'litesvm'.

type V8Module = { setFlagsFromString(flags: string): void }
type NodeProcess = { getBuiltinModule?: (id: string) => unknown }

const proc = (globalThis as { process?: NodeProcess }).process
const v8 = proc?.getBuiltinModule?.('node:v8') as V8Module | undefined
if (!v8) throw new Error('The LiteSVM harness needs Node ≥ 22.3 (process.getBuiltinModule).')
v8.setFlagsFromString('--no-allocation-site-pretenuring')

export const LITESVM_V8_WORKAROUND = true
