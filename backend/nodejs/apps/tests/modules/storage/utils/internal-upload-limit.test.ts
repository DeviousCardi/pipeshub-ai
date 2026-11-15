/**
 * J26-N3 (WP-69): Node reads the deployment's HARNESS_INPUT_MAX_MB as the worker does: unset or blank is 100 MiB,
 * anything but a positive whole number refuses (the storage router is built at start, so the app does not start).
 */
import { expect } from 'chai'
import {
  checkInternalUploadLimit,
  DEFAULT_INPUT_MAX_MB,
  harnessInputMaxBytes,
  internalUploadMaxBytes,
} from '../../../../src/modules/storage/utils/internal-upload-limit'

const MIB = 1024 * 1024

describe('J26-N3: the deployment input cap on the internal upload route', () => {
  it('is 100 MiB unless the operator sets it', () => {
    expect(DEFAULT_INPUT_MAX_MB).to.equal(100)
    expect(harnessInputMaxBytes({})).to.equal(100 * MIB)
    expect(harnessInputMaxBytes({ HARNESS_INPUT_MAX_MB: ' ' })).to.equal(100 * MIB)
    expect(harnessInputMaxBytes({ HARNESS_INPUT_MAX_MB: ' 512 ' })).to.equal(512 * MIB)
  })

  for (const raw of ['0', '-5', 'lots', '1.5', '12x', '1e3']) {
    it(`refuses ${JSON.stringify(raw)}`, () => {
      expect(() => harnessInputMaxBytes({ HARNESS_INPUT_MAX_MB: raw })).to.throw(/HARNESS_INPUT_MAX_MB/)
    })
  }

  const ON = { AGENT_HARNESS_WORKER_ENABLED: 'true' }

  it("takes the larger of the platform's upload cap and the input cap with the harness on", () => {
    expect(internalUploadMaxBytes(30 * MIB, ON)).to.equal(100 * MIB)
    expect(internalUploadMaxBytes(500 * MIB, ON)).to.equal(500 * MIB)
    expect(internalUploadMaxBytes(30 * MIB, { ...ON, HARNESS_INPUT_MAX_MB: '20' })).to.equal(30 * MIB)
  })

  // The real storage cell (test_kb_push_storage_e2e) stores exactly 30 MiB and refuses one byte more on an install
  // without the harness; widening there too let a KB push past the platform's cap.
  it("keeps the platform's cap alone with the harness off, and never reads the input cap", () => {
    expect(internalUploadMaxBytes(30 * MIB, {})).to.equal(30 * MIB)
    expect(internalUploadMaxBytes(30 * MIB, { AGENT_HARNESS_WORKER_ENABLED: 'false', HARNESS_INPUT_MAX_MB: '512' })).to.equal(30 * MIB)
    expect(() => checkInternalUploadLimit({ HARNESS_INPUT_MAX_MB: 'lots' })).not.to.throw()
    expect(() => checkInternalUploadLimit({ ...ON, HARNESS_INPUT_MAX_MB: 'lots' })).to.throw(/HARNESS_INPUT_MAX_MB/)
  })
})
