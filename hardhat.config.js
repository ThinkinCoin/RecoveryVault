require('@nomicfoundation/hardhat-toolbox');
require('@nomicfoundation/hardhat-verify');

require("dotenv").config();


const privateKey = process.env.DEPLOYER_PKEY || '';
// Fallback initialOwner if not set via environment
const initialOwner = process.env.INITIAL_OWNER || '0x45B96eD5d5B18f4f865266D8371C662Cd241e6D5';

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  // Expose initialOwner for deployment scripts
  initialOwner,

  defaultNetwork: 'hardhat',

  solidity: {
    version: '0.8.18',
    settings: {
      viaIR: false,
      optimizer: {
        runs: 200,
        enabled: true,
        details: {
          yulDetails: { optimizerSteps: "u" },
        },
      },
    },
  },

    networks: {
      hardhat: {},
      harmony: {
        url: process.env.VITE_RPC_URL || '',
        accounts: privateKey ? [`0x${privateKey}`] : []
      }
    },

    etherscan: {
      apiKey: {
        harmony: process.env.VITE_HARMONY_EXPLORER_API_KEY || ''
      },
      customChains: [
        {
          network: 'harmony',
          chainId: 1666600000,
          urls: {
            apiURL: 'https://explorer.harmony.one/api',
            browserURL: 'https://explorer.harmony.one'
          }
        }
      ]
    },

    typechain: {
      outDir: 'typechain-types',
      target: 'ethers-v6'
    }
  };
