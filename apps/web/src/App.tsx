import React, { useState, useEffect } from 'react';
import { Shield, Layers, Lock, Globe, Users, ExternalLink, RefreshCw, Activity, Terminal, CheckCircle2, ChevronRight, Search, Plus } from 'lucide-react';

interface AppItem {
  id: string;
  name: string;
  slug: string;
  shareUrl: string;
  visibility: 'private' | 'org' | 'link';
  status: 'ready' | 'building' | 'error';
  ownerId: string;
  createdAt: string;
}

interface AuditItem {
  id: string;
  actorId: string;
  actorType: string;
  action: string;
  metadata: any;
  timestamp: string;
}

const API_BASE_URL = (import.meta as any).env?.VITE_API_URL || (typeof window !== 'undefined' && window.location.hostname === 'localhost' ? 'http://localhost:4000' : 'https://tinycloud-api-1054958029786.us-central1.run.app');

export default function App() {
  const [apps, setApps] = useState<AppItem[]>([]);
  const [selectedApp, setSelectedApp] = useState<AppItem | null>(null);
  const [auditLog, setAuditLog] = useState<AuditItem[]>([]);
  const [activeTab, setActiveTab] = useState<'catalog' | 'audit'>('catalog');
  const [searchQuery, setSearchQuery] = useState('');
  const [publishing, setPublishing] = useState(false);

  // Fetch apps from Control Plane API
  const fetchApps = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/apps`);
      const data = await res.json();
      if (data.apps && data.apps.length > 0) {
        setApps(data.apps);
      } else {
        // Fallback demo state if API is offline
        setApps([
          {
            id: 'app_approval-tracker',
            name: 'Internal Approval Tracker',
            slug: 'approval-tracker',
            shareUrl: 'https://approval-tracker.cloudery.xyz',
            visibility: 'org',
            status: 'ready',
            ownerId: 'agent_claude',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'app_team-metrics',
            name: 'Q3 Team Metrics Dashboard',
            slug: 'team-metrics',
            shareUrl: 'https://team-metrics.cloudery.xyz',
            visibility: 'link',
            status: 'ready',
            ownerId: 'alex@acme.com',
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    } catch {
      // Offline fallback
      setApps([
        {
          id: 'app_approval-tracker',
          name: 'Internal Approval Tracker',
          slug: 'approval-tracker',
          shareUrl: 'https://approval-tracker.cloudery.xyz',
          visibility: 'org',
          status: 'ready',
          ownerId: 'agent_claude',
          createdAt: new Date().toISOString(),
        },
      ]);
    }
  };

  useEffect(() => {
    fetchApps();
  }, []);

  const handlePublishDemoApp = async () => {
    setPublishing(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/apps/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `CRM Mini ${Math.floor(Math.random() * 1000)}`,
          files: { 'index.html': '<h1>CRM Mini App</h1>' },
          visibility: 'org',
          actorId: 'agent_claude',
          actorType: 'agent',
        }),
      });
      const data = await res.json();
      await fetchApps();
    } catch (e) {
      console.error('Publish error:', e);
    } finally {
      setPublishing(false);
    }
  };

  const loadAuditLog = async (appId: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/apps/${appId}/audit`);
      const data = await res.json();
      setAuditLog(data.auditLog || []);
    } catch {
      setAuditLog([
        {
          id: 'aud_1',
          actorId: 'agent_claude',
          actorType: 'agent',
          action: 'deploy',
          metadata: { appName: selectedApp?.name, visibility: 'org' },
          timestamp: new Date().toISOString(),
        },
        {
          id: 'aud_2',
          actorId: 'alex@acme.com',
          actorType: 'user',
          action: 'access_granted',
          metadata: { userEmail: 'alex@acme.com' },
          timestamp: new Date().toISOString(),
        },
      ]);
    }
  };

  const [accessRequests, setAccessRequests] = useState<any[]>([]);

  const loadAccessRequests = async (appId: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/apps/${appId}/access-requests`);
      const data = await res.json();
      setAccessRequests(data.accessRequests || []);
    } catch {
      setAccessRequests([]);
    }
  };

  const handleApproveRequest = async (appId: string, requestId: string) => {
    try {
      await fetch(`${API_BASE_URL}/api/apps/${appId}/access-requests/${requestId}/approve`, { method: 'POST' });
      await loadAccessRequests(appId);
      await fetchApps();
    } catch (e) {
      console.error('Approve failed:', e);
    }
  };

  useEffect(() => {
    if (selectedApp) {
      loadAuditLog(selectedApp.id);
      loadAccessRequests(selectedApp.id);
    }
  }, [selectedApp]);

  const filteredApps = apps.filter(a => a.name.toLowerCase().includes(searchQuery.toLowerCase()) || a.slug.includes(searchQuery));

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Top Navbar */}
      <header style={{
        borderBottom: '1px solid var(--border-subtle)',
        background: 'rgba(9, 13, 22, 0.85)',
        backdropFilter: 'blur(12px)',
        padding: '16px 32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 50
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '36px',
            height: '36px',
            borderRadius: '10px',
            background: 'linear-gradient(135deg, var(--primary), var(--accent-cyan))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 16px rgba(99, 102, 241, 0.4)'
          }}>
            <Shield size={20} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: '18px', fontWeight: 800, letterSpacing: '-0.02em', background: 'linear-gradient(90deg, #fff, #9ca3af)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              TinyCloud
            </h1>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>Agent-First App Registry & Trust Layer</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.2)', padding: '6px 12px', borderRadius: '20px', fontSize: '12px', color: 'var(--accent-emerald)', fontWeight: 600 }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent-emerald)', boxShadow: '0 0 8px var(--accent-emerald)' }}></span>
            Remote MCP Connected
          </div>

          <button 
            onClick={handlePublishDemoApp}
            disabled={publishing}
            style={{
              background: 'linear-gradient(135deg, var(--primary), #4f46e5)',
              color: '#fff',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '8px',
              fontWeight: 600,
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'transform 0.2s, opacity 0.2s',
              opacity: publishing ? 0.7 : 1
            }}>
            {publishing ? <RefreshCw size={14} className="spin" /> : <Plus size={16} />}
            Publish Demo App (Agent)
          </button>
        </div>
      </header>

      {/* Main Container */}
      <div style={{ flex: 1, padding: '32px', maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
        {/* Navigation Tabs & Search */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <div style={{ display: 'flex', gap: '8px', background: 'rgba(18, 26, 42, 0.6)', padding: '4px', borderRadius: '10px', border: '1px solid var(--border-subtle)' }}>
            <button
              onClick={() => setActiveTab('catalog')}
              style={{
                padding: '8px 18px',
                borderRadius: '8px',
                border: 'none',
                background: activeTab === 'catalog' ? 'var(--primary)' : 'transparent',
                color: activeTab === 'catalog' ? '#fff' : 'var(--text-muted)',
                fontWeight: 600,
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                transition: 'all 0.2s'
              }}>
              <Layers size={16} /> Org App Catalog ({apps.length})
            </button>
            <button
              onClick={() => setActiveTab('audit')}
              style={{
                padding: '8px 18px',
                borderRadius: '8px',
                border: 'none',
                background: activeTab === 'audit' ? 'var(--primary)' : 'transparent',
                color: activeTab === 'audit' ? '#fff' : 'var(--text-muted)',
                fontWeight: 600,
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                transition: 'all 0.2s'
              }}>
              <Activity size={16} /> Audit & Governance Log
            </button>
          </div>

          <div style={{ position: 'relative', width: '280px' }}>
            <Search size={16} color="var(--text-muted)" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
            <input
              type="text"
              placeholder="Search internal tools..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                background: 'rgba(18, 26, 42, 0.8)',
                border: '1px solid var(--border-subtle)',
                padding: '8px 12px 8px 36px',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '13px',
                outline: 'none'
              }}
            />
          </div>
        </div>

        {/* Catalog Tab */}
        {activeTab === 'catalog' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '20px' }}>
            {filteredApps.map((appItem) => (
              <div
                key={appItem.id}
                onClick={() => setSelectedApp(appItem)}
                style={{
                  background: 'var(--bg-card)',
                  border: selectedApp?.id === appItem.id ? '1px solid var(--primary-light)' : '1px solid var(--border-subtle)',
                  borderRadius: '14px',
                  padding: '20px',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  boxShadow: selectedApp?.id === appItem.id ? '0 0 20px rgba(99, 102, 241, 0.25)' : 'none'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--primary-light)')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = selectedApp?.id === appItem.id ? 'var(--primary-light)' : 'var(--border-subtle)')}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                  <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#fff' }}>{appItem.name}</h3>
                  <span style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    padding: '3px 8px',
                    borderRadius: '12px',
                    textTransform: 'uppercase',
                    background: appItem.visibility === 'org' ? 'rgba(99, 102, 241, 0.15)' : appItem.visibility === 'link' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                    color: appItem.visibility === 'org' ? 'var(--primary-light)' : appItem.visibility === 'link' ? 'var(--accent-emerald)' : 'var(--accent-amber)',
                    border: '1px solid currentColor'
                  }}>
                    {appItem.visibility}
                  </span>
                </div>

                <div className="mono" style={{ fontSize: '12px', color: 'var(--accent-cyan)', marginBottom: '16px', wordBreak: 'break-all' }}>
                  {appItem.shareUrl}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '12px', borderTop: '1px solid var(--border-subtle)', fontSize: '12px', color: 'var(--text-muted)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Terminal size={14} /> Owner: <strong style={{ color: '#e5e7eb' }}>{appItem.ownerId}</strong>
                  </div>
                  <ExternalLink size={14} color="var(--primary-light)" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Selected App Governance Modal / Drawer */}
        {selectedApp && (
          <div style={{
            marginTop: '32px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-glow)',
            borderRadius: '16px',
            padding: '28px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div>
                <h2 style={{ fontSize: '20px', fontWeight: 800 }}>{selectedApp.name} Settings & Policy</h2>
                <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Doc-like share settings enforced by Edge Auth Gateway</p>
              </div>
              <button
                onClick={() => setSelectedApp(null)}
                style={{ background: 'transparent', border: '1px solid var(--border-subtle)', color: '#fff', padding: '6px 12px', borderRadius: '6px' }}>
                Close
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
              <div>
                <h4 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>Access Control Policy</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                    <input type="radio" name="vis" checked={selectedApp.visibility === 'org'} onChange={() => setSelectedApp({ ...selectedApp, visibility: 'org' })} />
                    <Users size={16} color="var(--primary-light)" />
                    <div>
                      <strong style={{ fontSize: '13px' }}>Org Members Only</strong>
                      <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Restricted to anyone with @acme.com domain</p>
                    </div>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                    <input type="radio" name="vis" checked={selectedApp.visibility === 'link'} onChange={() => setSelectedApp({ ...selectedApp, visibility: 'link' })} />
                    <Globe size={16} color="var(--accent-emerald)" />
                    <div>
                      <strong style={{ fontSize: '13px' }}>Anyone with Share Link</strong>
                      <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Accessible by anyone possessing the URL</p>
                    </div>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                    <input type="radio" name="vis" checked={selectedApp.visibility === 'private'} onChange={() => setSelectedApp({ ...selectedApp, visibility: 'private' })} />
                    <Lock size={16} color="var(--accent-amber)" />
                    <div>
                      <strong style={{ fontSize: '13px' }}>Restricted Allowlist</strong>
                      <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Only specific allowed emails</p>
                    </div>
                  </label>
                </div>
              </div>

              <div>
                <h4 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>Pending Access Requests ({accessRequests.filter(r => r.status === 'pending').length})</h4>
                <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '10px', padding: '12px', height: '180px', overflowY: 'auto' }}>
                  {accessRequests.length === 0 ? (
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No pending access requests.</p>
                  ) : (
                    accessRequests.map((reqItem) => (
                      <div key={reqItem.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                        <div>
                          <strong style={{ color: '#fff' }}>{reqItem.requesterEmail}</strong>
                          <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{reqItem.reason}</p>
                        </div>
                        {reqItem.status === 'pending' ? (
                          <button
                            onClick={() => handleApproveRequest(selectedApp.id, reqItem.id)}
                            style={{ background: 'var(--accent-emerald)', color: '#000', border: 'none', padding: '4px 10px', borderRadius: '4px', fontWeight: 700, fontSize: '11px' }}>
                            Approve
                          </button>
                        ) : (
                          <span style={{ fontSize: '11px', color: 'var(--accent-emerald)', fontWeight: 700 }}>Approved</span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Audit Tab */}
        {activeTab === 'audit' && (
          <div style={{ background: 'var(--bg-card)', borderRadius: '16px', border: '1px solid var(--border-subtle)', padding: '24px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 800, marginBottom: '16px' }}>Organization Governance & Audit Log</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {apps.map(appItem => (
                <div key={appItem.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.02)', padding: '14px 20px', borderRadius: '10px', border: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <Shield size={18} color="var(--primary-light)" />
                    <div>
                      <strong style={{ fontSize: '14px' }}>{appItem.name}</strong>
                      <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Deployed by {appItem.ownerId} • Policy: {appItem.visibility}</p>
                    </div>
                  </div>
                  <div className="mono" style={{ fontSize: '12px', color: 'var(--accent-cyan)' }}>
                    {appItem.shareUrl}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
