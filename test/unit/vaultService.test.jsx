// test/unit/vaultService.test.jsx
import { describe, it, expect, vi } from 'vitest';
import * as vaultService from '../../src/services/vaultService';
import { parseEther } from 'viem/utils';

vi.mock('../../src/utils/contractInstance', () => ({
  getVaultContract: vi.fn(() => ({
    quoteRedeem: vi.fn().mockResolvedValue([
      true, true, 1000, 9900, 100, 0, 10, 18, 18, 820000, 6
    ]),
    getUserLimit: vi.fn().mockResolvedValue(90)
  }))
}));

describe('vaultService', () => {
  it('should return quoteRedeem result with expected values', async () => {
    const result = await vaultService.quoteRedeem({
      user: '0xabc',
      tokenIn: '0xwone',
      amountIn: parseEther('1'),
      redeemIn: '0xwone',
      proof: []
    });

    expect(result.usdValue).toBe(10);
    expect(result.feeAmount).toBe(1000);
    expect(result.refundAmount).toBe(9900);
  });

  it('should get user limit correctly', async () => {
    const limit = await vaultService.getUserLimit('0xabc', {});
    expect(limit).toBe(90);
  });
});
