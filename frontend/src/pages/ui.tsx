import type { CSSProperties, ReactNode } from 'react'

export const cardStyle: CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '18px 20px',
  marginBottom: 16
}

export const headStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 14
}

export const titleStyle: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600 }

export const btnStyle: CSSProperties = {
  background: 'var(--panel-2)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  borderRadius: 8,
  padding: '6px 12px',
  fontSize: 12.5,
  cursor: 'pointer'
}

export const primaryBtnStyle: CSSProperties = {
  ...btnStyle,
  background: 'var(--accent)',
  borderColor: 'transparent',
  color: '#fff',
  fontWeight: 600
}

export const inputStyle: CSSProperties = {
  background: 'var(--panel-2)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  borderRadius: 8,
  padding: '7px 10px',
  fontSize: 12.5,
  width: '100%'
}

export const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }
export const thStyle: CSSProperties = {
  textAlign: 'left', color: 'var(--muted)', fontWeight: 500,
  padding: '9px 10px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap'
}
export const tdStyle: CSSProperties = {
  padding: '9px 10px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap'
}

export function Card({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div style={cardStyle}>
      <div style={headStyle}>
        <h2 style={titleStyle}>{title}</h2>
        {extra && <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>{extra}</span>}
      </div>
      {children}
    </div>
  )
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ ...cardStyle, marginBottom: 0 }}>
      <div style={{ color: 'var(--muted)', fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 650, marginTop: 8, letterSpacing: -0.5 }}>{value}</div>
      {hint && <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 6 }}>{hint}</div>}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div style={{ color: 'var(--muted)', fontSize: 12.5, textAlign: 'center', padding: '36px 0' }}>{children}</div>
}
