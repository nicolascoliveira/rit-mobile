// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  vi.stubEnv('VITE_MOBILE', '1')
  return {
    arm: vi.fn(async () => ({ lastId: 0 })),
    poll: vi.fn(async () => ({ ok: true, latestId: 0, notifications: [] })),
    disarm: vi.fn(async () => {}),
    appStateCb: null,
    remote: { base: 'https://app.treinerit.duckdns.org', headers: { Authorization: 'Bearer TOK' } }
  }
})

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: name => {
    if (name === 'RitInbox') return { arm: h.arm, poll: h.poll, disarm: h.disarm }
    return {}
  }
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (_ev, cb) => {
      h.appStateCb = cb
      return { remove: vi.fn() }
    }
  }
}))

vi.mock('./api.js', () => ({
  remoteAuth: () => h.remote
}))

import { startMobileInbox, disarmMobileInbox, _resetMobileInbox } from './mobile-inbox.js'

beforeEach(() => {
  vi.useFakeTimers()
  _resetMobileInbox()
  h.arm.mockClear()
  h.poll.mockReset()
  h.poll.mockResolvedValue({ ok: true, latestId: 0, notifications: [] })
  h.disarm.mockClear()
  h.appStateCb = null
  h.remote = { base: 'https://app.treinerit.duckdns.org', headers: { Authorization: 'Bearer TOK' } }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('mobile-inbox', () => {
  it('arms native RitInbox, polls immediately and notifies caller on new updates', async () => {
    const onUpdates = vi.fn()
    h.poll.mockResolvedValueOnce({
      ok: true,
      latestId: 7,
      notifications: [{ id: 7, title: 'Nova ficha liberada!', body: 'Treino A atualizado', tag: 'prescription-update' }]
    })

    const stop = startMobileInbox({ userId: 'u-stu', onUpdates, intervalMs: 10000 })
    await vi.advanceTimersByTimeAsync(10)

    expect(h.arm).toHaveBeenCalledWith({
      server: 'https://app.treinerit.duckdns.org',
      headers: { Authorization: 'Bearer TOK' },
      userId: 'u-stu'
    })
    expect(h.poll).toHaveBeenCalledTimes(1)
    expect(onUpdates).toHaveBeenCalledTimes(1)
    expect(onUpdates.mock.calls[0][0][0].tag).toBe('prescription-update')

    await vi.advanceTimersByTimeAsync(10000)
    expect(h.poll).toHaveBeenCalledTimes(2)

    stop()
    await vi.advanceTimersByTimeAsync(20000)
    expect(h.poll).toHaveBeenCalledTimes(2)
  })

  it('disarms cleanly when called on sign-out', async () => {
    expect(await disarmMobileInbox()).toBe(true)
    expect(h.disarm).toHaveBeenCalledTimes(1)
  })
})
