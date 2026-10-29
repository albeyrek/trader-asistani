// Portföy ve risk profili: telefonda saklanır (AsyncStorage), sunucuya gönderilmez.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { Market } from './types';

const POSITIONS_KEY = 'portfolio';
const PROFILE_KEY = 'riskProfile';

export interface Position {
  symbol: string;
  market: Market;
  qty: number;
  cost: number; // ortalama maliyet (birim fiyat)
  opened: string; // ilk alım tarihi (ISO)
}

export interface RiskProfile {
  capitalTRY: number;
  capitalUSD: number;
  riskPct: number; // işlem başına riske edilen sermaye yüzdesi
}

const DEFAULT_PROFILE: RiskProfile = { capitalTRY: 100_000, capitalUSD: 5_000, riskPct: 1 };

interface PortfolioValue {
  ready: boolean;
  positions: Position[];
  profile: RiskProfile;
  setProfile: (p: RiskProfile) => void;
  /** Aynı hisse varsa ağırlıklı ortalama maliyetle birleştirir. */
  addPosition: (p: { symbol: string; market: Market; qty: number; price: number }) => void;
  removePosition: (symbol: string, market: Market) => void;
  getPosition: (symbol: string, market: Market) => Position | undefined;
  capitalFor: (market: Market) => number;
}

const PortfolioContext = createContext<PortfolioValue | null>(null);

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [positions, setPositions] = useState<Position[]>([]);
  const [profile, setProfileState] = useState<RiskProfile>(DEFAULT_PROFILE);

  useEffect(() => {
    (async () => {
      try {
        const [p, prof] = await Promise.all([AsyncStorage.getItem(POSITIONS_KEY), AsyncStorage.getItem(PROFILE_KEY)]);
        if (p) setPositions(JSON.parse(p));
        if (prof) setProfileState({ ...DEFAULT_PROFILE, ...JSON.parse(prof) });
      } catch {
        // okunamazsa boş portföyle devam
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const save = (next: Position[]) => {
    AsyncStorage.setItem(POSITIONS_KEY, JSON.stringify(next)).catch(() => {});
    return next;
  };

  const setProfile = useCallback((p: RiskProfile) => {
    setProfileState(p);
    AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(p)).catch(() => {});
  }, []);

  const addPosition = useCallback((p: { symbol: string; market: Market; qty: number; price: number }) => {
    if (!(p.qty > 0) || !(p.price > 0)) return;
    setPositions((prev) => {
      const i = prev.findIndex((x) => x.symbol === p.symbol && x.market === p.market);
      if (i < 0) {
        return save([...prev, { symbol: p.symbol, market: p.market, qty: p.qty, cost: p.price, opened: new Date().toISOString() }]);
      }
      const old = prev[i];
      const qty = old.qty + p.qty;
      const merged = { ...old, qty, cost: (old.qty * old.cost + p.qty * p.price) / qty };
      return save(prev.map((x, j) => (j === i ? merged : x)));
    });
  }, []);

  const removePosition = useCallback((symbol: string, market: Market) => {
    setPositions((prev) => save(prev.filter((x) => !(x.symbol === symbol && x.market === market))));
  }, []);

  const value = useMemo<PortfolioValue>(
    () => ({
      ready,
      positions,
      profile,
      setProfile,
      addPosition,
      removePosition,
      getPosition: (symbol, market) => positions.find((x) => x.symbol === symbol && x.market === market),
      capitalFor: (market) => (market === 'US' ? profile.capitalUSD : profile.capitalTRY),
    }),
    [ready, positions, profile, setProfile, addPosition, removePosition],
  );

  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

export function usePortfolio(): PortfolioValue {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error('usePortfolio, PortfolioProvider içinde kullanılmalı');
  return ctx;
}
