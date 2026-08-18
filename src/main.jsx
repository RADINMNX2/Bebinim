import React, { Component } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.error('App crashed:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-dvh bg-black flex flex-col items-center justify-center gap-4 p-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-zinc-950 border border-red-500/30 flex items-center justify-center shadow-[0_0_30px_rgba(239,68,68,0.3)]">
            <span className="text-2xl">🎬</span>
          </div>
          <h1 className="text-xl md:text-2xl font-bold text-red-500 font-persian">خطایی رخ داد!</h1>
          <p className="text-sm text-gray-400 font-persian max-w-md">
            متأسفانه مشکلی پیش آمد. لطفاً صفحه را رفرش کنید و دوباره تلاش کنید.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="btn-primary font-persian"
          >
            رفرش صفحه
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)