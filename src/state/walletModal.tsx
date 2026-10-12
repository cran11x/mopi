import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

interface WalletModalApi {
  visible: boolean
  open: () => void
  close: () => void
}

const WalletModalContext = createContext<WalletModalApi | null>(null)

/** Visibility of mopi's own wallet picker (components/layout/WalletModal). */
export function WalletModalProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false)
  const value = useMemo(
    () => ({ visible, open: () => setVisible(true), close: () => setVisible(false) }),
    [visible],
  )
  return <WalletModalContext.Provider value={value}>{children}</WalletModalContext.Provider>
}

export function useWalletModal(): WalletModalApi {
  const ctx = useContext(WalletModalContext)
  if (!ctx) throw new Error('useWalletModal must be used inside <WalletModalProvider>')
  return ctx
}
