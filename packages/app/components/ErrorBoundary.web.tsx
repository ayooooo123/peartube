import React, { Component, ReactNode } from 'react'
import { colors } from '@/lib/colors'

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
          <div style={styles.content}>
            <h1 style={styles.title}>Something went wrong</h1>
            <p style={styles.subtitle}>
              The app encountered an unexpected error.
            </p>

            {this.state.error && (
              <div style={styles.errorBox}>
                <p style={styles.errorTitle}>Error Details:</p>
                <p style={styles.errorMessage}>
                  {this.state.error.message}
                </p>
              </div>
            )}

            <button style={styles.retryButton} onClick={this.handleRetry}>
              <span style={styles.retryButtonText}>Try Again</span>
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
    padding: 24,
    minHeight: '100vh',
  },
  content: {
    maxWidth: 400,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 12,
    textAlign: 'center',
    margin: 0,
  },
  subtitle: {
    fontSize: 16,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: '24px',
    margin: 0,
  },
  errorBox: {
    backgroundColor: colors.bgElevated,
    borderRadius: 8,
    padding: 16,
    marginBottom: 24,
    width: '100%',
  },
  errorTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    margin: 0,
  },
  errorMessage: {
    fontSize: 13,
    color: colors.textMuted,
    fontFamily: 'monospace',
    margin: 0,
  },
  retryButton: {
    backgroundColor: colors.accent,
    paddingLeft: 32,
    paddingRight: 32,
    paddingTop: 14,
    paddingBottom: 14,
    borderRadius: 8,
    marginBottom: 24,
    border: 'none',
    cursor: 'pointer',
  },
  retryButtonText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  hint: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    margin: 0,
  },
}

export default ErrorBoundary
