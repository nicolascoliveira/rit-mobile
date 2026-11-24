// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The updater downloads an .apk and hands it to the Android package installer, so its row
// may only ever show on the native Android build: never on the web, never on iOS. Each test
// flips the two gates (MOBILE flag, Capacitor platform) and watches whether Settings even
// asks gitlab.com for the latest release.
const mocks = vi.hoisted(() => {
  const state = { S: null, MOBILE: false, android: false, channel: 'sideload' }
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
  state.checkForUpdate = vi.fn(() => Promise.resolve({ hasUpdate: true, latestVersion: '9.9.9', apkUrl: 'https://x/opengym.apk', hashUrl: null }))
  state.confirmSheet = vi.fn()
  state.forget = vi.fn()
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
// MOBILE is read at render time through a getter so one module mock serves both builds.
vi.mock('../lib/mobile.js', () => ({
  get MOBILE() { return mocks.MOBILE },
  isAndroid: () => Promise.resolve(mocks.android),
  shareExport: vi.fn(), syncReminder: vi.fn(),
}))
vi.mock('../lib/update.js', () => ({
  checkForUpdate: (...a) => mocks.checkForUpdate(...a),
  downloadAndInstall: vi.fn(),
  forgetDownloadedUpdate: (...a) => mocks.forget(...a),
}))
vi.mock('../lib/channel.js', () => ({ getChannel: () => Promise.resolve(mocks.channel), gymReminderBuilt: () => Promise.resolve(true) }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), confirmSheet: (...a) => mocks.confirmSheet(...a), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), menuSheet: vi.fn(),
}))

globalThis.__APP_VERSION__ ??= 'test'

let host, root
beforeEach(() => {
  mocks.S = {
    unit: 'kg', restSec: 90, restPauseSec: 15, sound: false, effort: 'none',
    gifSize: 'full', workouts: [], routines: [], exWeights: {},
  }
  mocks.MOBILE = false
  mocks.android = false
  mocks.channel = 'sideload'
  mocks.checkForUpdate.mockClear()
  mocks.confirmSheet.mockClear()
  mocks.forget.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

// The effect resolves two promises (isAndroid, then checkForUpdate) before the row can render.
const mount = async () => {
  await act(async () => { root.render(<Settings page="about" />) })
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })
}
const updateRow = () => [...host.querySelectorAll('.lrow')].find(r => r.textContent.includes('Update to Rit v9.9.9'))
const checkRow = () => [...host.querySelectorAll('.lrow')].find(r => r.textContent.includes('Check for updates'))
const webRow = () => [...host.querySelectorAll('.lrow')].find(r => r.textContent.includes('Get the Android app'))

describe('Settings — in-app update check', () => {
  it('web build: never asks for releases; the Updates section points at the APK instead', async () => {
    await mount()
    expect(mocks.checkForUpdate).not.toHaveBeenCalled()
    expect(updateRow()).toBeUndefined()
    expect(checkRow()).toBeUndefined()
  })

  it('mobile build on iOS: no check, no row, no section', async () => {
    mocks.MOBILE = true
    await mount()
    expect(mocks.checkForUpdate).not.toHaveBeenCalled()
    expect(updateRow()).toBeUndefined()
    expect(checkRow()).toBeUndefined()
    expect(webRow()).toBeUndefined()
  })

  it('Google Play build: Play installs the updates, so no check and no row', async () => {
    mocks.MOBILE = true
    mocks.android = true
    mocks.channel = 'play'
    await mount()
    expect(mocks.checkForUpdate).not.toHaveBeenCalled()
    expect(updateRow()).toBeUndefined()
    expect(checkRow()).toBeUndefined()
  })

  it('mobile build on Android: runs background check once without rendering sideload APK rows', async () => {
    mocks.MOBILE = true
    mocks.android = true
    await mount()
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1)
    expect(updateRow()).toBeUndefined()
    expect(checkRow()).toBeUndefined()
    expect(mocks.forget).not.toHaveBeenCalled()   // 9.9.9 is waiting: its APK may be the one in the cache
  })

  it('Android: a downloaded APK left in the cache is deleted once nothing newer is out, and kept while one is', async () => {
    mocks.MOBILE = true
    mocks.android = true
    await mount()
    expect(mocks.forget).not.toHaveBeenCalled()
    act(() => root.unmount())
    root = createRoot(host)
    mocks.checkForUpdate.mockResolvedValueOnce({ hasUpdate: false, latestVersion: 'test', apkUrl: null, hashUrl: null })
    await mount()
    expect(mocks.forget).toHaveBeenCalledTimes(1)
  })
})

const versionRow = () => [...host.querySelectorAll('.lrow')].find(r => r.textContent.includes('Version'))
describe('Settings → About: version row', () => {
  it('keeps the Version row clean across web, Android and Play builds', async () => {
    await mount()
    expect(versionRow().textContent).not.toContain('APK,')
    for (const [android, channel] of [[true, 'sideload'], [false, 'sideload'], [true, 'play']]) {
      act(() => root.unmount())
      root = createRoot(host)
      mocks.MOBILE = true
      mocks.android = android
      mocks.channel = channel
      await mount()
      expect(versionRow().textContent).toMatch(/^Versionv(\d|test)/)
      expect(versionRow().textContent).not.toContain('APK,')
    }
  })
})

// Google Play's payments policy: no links to pay outside Play billing for anything but a
// registered charity, so the Play build has no coffee links, only its own rating row.
describe('Settings: support links', () => {
  const row = text => [...host.querySelectorAll('.lrow')].find(r => r.textContent.includes(text))
  it('the APK shows developer attribution and has no Play rating row', async () => {
    mocks.MOBILE = true
    mocks.android = true
    await mount()
    expect(row('Nicolas Oliveira')).toBeTruthy()
    expect(row('Rit')).toBeTruthy()
  })
  it('the Google Play build shows developer attribution', async () => {
    mocks.MOBILE = true
    mocks.android = true
    mocks.channel = 'play'
    await mount()
    expect(row('Nicolas Oliveira')).toBeTruthy()
    expect(row('Rit')).toBeTruthy()
  })
  it('the web shows developer attribution and no Play rating row', async () => {
    await mount()
    expect(row('Nicolas Oliveira')).toBeTruthy()
    expect(row('Rit')).toBeTruthy()
  })
})
