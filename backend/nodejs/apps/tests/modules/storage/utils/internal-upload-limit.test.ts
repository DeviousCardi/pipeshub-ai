/**
 * J26-N3 (WP-69): Node reads the deployment's HARNESS_INPUT_MAX_MB as the worker does: unset or blank is 100 MiB,
 * anything but a positive whole number refuses (the storage router is built at start, so the app does not start).
 */
import { expect } from 'chai'
import {
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

  it("takes the larger of the platform's upload cap and the input cap", () => {
    expect(internalUploadMaxBytes(30 * MIB, {})).to.equal(100 * MIB)
    expect(internalUploadMaxBytes(500 * MIB, {})).to.equal(500 * MIB)
    expect(internalUploadMaxBytes(30 * MIB, { HARNESS_INPUT_MAX_MB: '20' })).to.equal(30 * MIB)
  })
})
