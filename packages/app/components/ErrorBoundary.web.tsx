import React, { Component, ReactNode } from 'react'
import { colors, radius, spacing } from '@/lib/colors'
import { fonts } from '@/lib/typography'

interface ErrorBoundaryProps {
  children: ReactNode
  onRetry?: () => void
  fallback?: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error.message)
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack)

    this.setState({ errorInfo })

    this.logErrorLocally(error, errorInfo)
  }

  private logErrorLocally(error: Error, errorInfo: React.ErrorInfo) {
    try {
      const errorLog = {
        timestamp: new Date().toISOString(),
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        platform: 'web',
      }

      console.log('[ErrorBoundary] Error log:', JSON.stringify(errorLog, null, 2))
    } catch {
      // Ignore logging errors
    }
  }

  handleRetry = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    })
    this.props.onRetry?.()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div style={styles.container}>
          <div style={styles.panel}>
            <p style={styles.eyebrow}>ERROR</p>
            <h1 style={styles.title}>Something went wrong</h1>
            <p style={styles.subtitle}>
              The app encountered an unexpected error.
            </p>

            {this.state.error && (
              <div style={styles.errorBox}>
                <p style={styles.errorTitle}>Error Details:</p>
                <p style={styles.errorMessage}>
                  {this.state.error.message}
                  {this.state.errorInfo?.componentStack
                    ? `\n${this.state.errorInfo.componentStack}`
                    : ''}
                </p>
              </div>
            )}

            <button type="button" style={styles.retryButton} onClick={this.handleRetry}>
              <span style={styles.retryButtonText}>RETRY</span>
            </button>

            <p style={styles.hint}>
              If this keeps happening, try restarting the app.
            </p>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
    minHeight: '100vh',
  },
  panel: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.surface,
    border: `2px solid ${colors.error}`,
    borderRadius: radius.card,
    padding: spacing.lg,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  eyebrow: {
    margin: 0,
    fontFamily: fonts.monoMedium,
    fontSize: 11,
    lineHeight: '14px',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.error,
  },
  title: {
    margin: 0,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    fontFamily: fonts.heading,
    fontSize: 18,
    lineHeight: '22px',
    color: colors.text,
  },
  subtitle: {
    margin: 0,
    marginBottom: spacing.lg,
    fontSize: 14,
    lineHeight: '20px',
    color: colors.textSecondary,
  },
  errorBox: {
    backgroundColor: colors.surfaceHover,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.card,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    width: '100%',
    boxSizing: 'border-box',
  },
  errorTitle: {
    margin: 0,
    marginBottom: spacing.sm,
    fontFamily: fonts.monoMedium,
    fontSize: 11,
    lineHeight: '14px',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  errorMessage: {
    margin: 0,
    fontFamily: fonts.mono,
    fontSize: 10,
    lineHeight: '12px',
    color: colors.error,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  retryButton: {
    backgroundColor: 'transparent',
    border: `2px solid ${colors.border}`,
    borderRadius: radius.card,
    paddingLeft: spacing.xl,
    paddingRight: spacing.xl,
    paddingTop: 12,
    paddingBottom: 12,
    marginBottom: spacing.lg,
    cursor: 'pointer',
  },
  retryButtonText: {
    color: colors.text,
    fontFamily: fonts.heading,
    fontSize: 13,
    lineHeight: '16px',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  hint: {
    margin: 0,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: '16px',
    color: colors.textMuted,
  },
}

export default ErrorBoundary
