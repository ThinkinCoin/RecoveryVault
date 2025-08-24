// @/components/shared/TokenSelect.jsx

import React, { useEffect, useRef, useState } from 'react';
import styles from '@/styles/Global.module.css';
import { getTokens } from '@/services/tokenService';

const TokenSelector = ({ label, selectedToken, onSelect }) => {
  const [tokenList, setTokenList] = useState([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    try {
      const list = getTokens();
      setTokenList(Array.isArray(list) ? list : []);
    } catch {
      setTokenList([]);
    }
  }, []);

  // Close when clicking outside
  useEffect(() => {
    function handleOutside(e) {
      if (open && rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  const handleSelect = (token) => {
    onSelect?.(token);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={styles.field} style={{ position: 'relative' }}>
      {label && <label className={styles.contractFundsLabel}>{label}</label>}

      {/* Toggle button */}
      <button
        type="button"
        className={`${styles.button} ${styles.selectDropdown}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {selectedToken ? (
          <>
            <img
              src={selectedToken.logoURI}
              alt={selectedToken.symbol}
              style={{ width: 24, height: 24, borderRadius: '50%', marginRight: 8 }}
            />
            <span>{selectedToken.symbol}</span>
          </>
        ) : (
          <span>Select Token</span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <ul
          className={styles.selectorDropdown}
          role="listbox"
          >
          {tokenList.map((token) => (
            <li
              key={token.address}
              role="option"
              aria-selected={selectedToken?.address === token.address}
              className={styles.rowSm}
              onClick={() => handleSelect(token)}
              style={{ cursor: 'pointer', padding: '6px 4px' }}
            >
              <img
                src={token.logoURI}
                alt={token.symbol}
                style={{ width: 22, height: 22, borderRadius: '50%', marginRight: 8 }}
              />
              <span>{token.symbol}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default TokenSelector;
