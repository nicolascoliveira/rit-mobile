// @vitest-environment happy-dom
// The backup-folder rows (#161) sit under Auto-backup, on Android only, and only while it is on.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'
import { bindUI } from '../components/ui.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state = { S: null, MOBILE: true, android: true, folder: {}, asked: [] }
  state.snapshot = () => ({
    S: state.S,
    user: null,
    update: mut => {
      const next = structuredClone(state.S)
      mut(next)
      state.S = next
    },
    replaceState: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(),
    signOut: vi.fn(), signOutAll: vi.fn(), resetDemo: vi.fn(), disconnectServer: vi.fn(),
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, DEF: { reminder: { time: '17:30' } }, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: vi.fn() })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(), webauthnOK: () => false, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), IS_ANDROID: false,
}))
vi.mock('../lib/push.js', () => ({ pushSupported: () => false, enablePush: vi.fn(), disablePush: vi.fn(), sendTestPush: vi.fn() }))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => false }))
vi.mock('../lib/mobile.js', () => ({ get MOBILE() { return mocks.MOBILE }, isAndroid: () => Promise.resolve(mocks.android), shareExport: vi.fn(), syncReminder: vi.fn() }))
vi.mock('../components/BackupFolderRow.jsx', async () => {
  const real = await vi.importActual('../components/BackupFolderRow.jsx')
  return {
    default: () => <div className="backup-folder-row" />,
    useBackupFolder: enabled => { mocks.asked.push(enabled); return [enabled ? mocks.folder : null, () => {}] },
    autoBackupSubtitle: real.autoBackupSubtitle,
  }
})
vi.mock('../lib/update.js', () => ({ checkForUpdate: () => new Promise(() => {}), downloadAndInstall: vi.fn() }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  loadStarterPlan: vi.fn(), starterPlanSheet: vi.fn(), confirmSheet: vi.fn(), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(),
}))

// The Settings view reads the build-time version constant at render time.
globalThis.__APP_VERSION__ ??= 'test'

// SelectRow opens its choices through the bound UI store; capture the sheet to render it here.
let sheet = null
bindUI({ getState: () => ({ openSheet: render => { sheet = render; return { close: () => {} } } }) })

let host, root
beforeEach(() => {
  sheet = null
  mocks.S = {
    unit: 'kg', restSec: 90, restPauseSec: 15, sound: false, effort: 'none',
    gifSize: 'full', workouts: [], routines: [], exWeights: {},
  }
  mocks.MOBILE = true
  mocks.android = true
  mocks.folder = {}
  mocks.asked = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = async () => { await act(async () => { root.render(<Settings page="data" />) }) }
const shown = () => !!host.querySelector('.backup-folder-row')

describe('B2B Data & backup page and autoBackupSubtitle helper', () => {
  it('shows Relatórios e exportação (PDF and CSV) without local backup folder clutter', async () => {
    mocks.S.autoBackup = true
    await mount()
    expect(shown()).toBe(false)
    expect(host.textContent).toContain('Relatórios e exportação')
    expect(host.textContent).toContain('Performance report (PDF)')
    expect(host.textContent).toContain('Export as spreadsheet (CSV)')
  })

  it('autoBackupSubtitle names the chosen folder or Documents/Rit', async () => {
    const { autoBackupSubtitle } = await import('../components/BackupFolderRow.jsx')
    const custom = autoBackupSubtitle({ uri: 'content://tree/Sync', label: 'SyncFolder' }, 14)
    expect(custom).toContain('“SyncFolder”')
    expect(custom).not.toContain('Documents/Rit')
    const def = autoBackupSubtitle({}, 14)
    expect(def).toContain('Documents/Rit')
  })
})
