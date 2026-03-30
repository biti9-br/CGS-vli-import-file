import React, { useState, useEffect } from 'react';
import { Play, Pause, Square, RefreshCw, CheckCircle2, XCircle, Clock, FileText, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';

interface Job {
  id: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  progress: number;
  total: number;
  createdAt: string;
  updatedAt: string;
}

export default function JobsDashboard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [jobDetails, setJobDetails] = useState<any>(null);

  const fetchJobs = async () => {
    try {
      const res = await fetch('/api/jobs');
      const data = await res.json();
      setJobs(data);
    } catch (e) {
      console.error('Failed to fetch jobs', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 3000);
    return () => clearInterval(interval);
  }, []);

  const fetchJobDetails = async (id: string) => {
    try {
      const res = await fetch(`/api/jobs/${id}`);
      const data = await res.json();
      setJobDetails(data);
    } catch (e) {
      console.error('Failed to fetch job details', e);
    }
  };

  useEffect(() => {
    if (selectedJob) {
      fetchJobDetails(selectedJob);
      const interval = setInterval(() => fetchJobDetails(selectedJob), 3000);
      return () => clearInterval(interval);
    }
  }, [selectedJob]);

  const handleStop = async (id: string) => {
    await fetch(`/api/jobs/${id}/stop`, { method: 'POST' });
    fetchJobs();
  };

  const handleResume = async (id: string) => {
    await fetch(`/api/jobs/${id}/resume`, { method: 'POST' });
    fetchJobs();
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'running': return <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700 flex items-center gap-1"><RefreshCw size={12} className="animate-spin" /> Em Execução</span>;
      case 'completed': return <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 flex items-center gap-1"><CheckCircle2 size={12} /> Concluído</span>;
      case 'failed': return <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700 flex items-center gap-1"><XCircle size={12} /> Falha</span>;
      case 'paused': return <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700 flex items-center gap-1"><Pause size={12} /> Pausado</span>;
      default: return <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 flex items-center gap-1"><Clock size={12} /> Pendente</span>;
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 md:p-8 min-h-[500px] animate-in fade-in duration-300">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
          <FileText className="text-indigo-600" />
          Gerenciador de Importações
        </h2>
        <button onClick={fetchJobs} className="p-2 text-slate-400 hover:text-indigo-600 transition-colors rounded-lg hover:bg-slate-50">
          <RefreshCw size={20} />
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center items-center h-40">
          <RefreshCw className="animate-spin text-indigo-600" size={24} />
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-12 bg-slate-50 rounded-xl border border-dashed border-slate-300">
          <FileText className="mx-auto h-12 w-12 text-slate-400 mb-3" />
          <h3 className="text-sm font-medium text-slate-900">Nenhuma importação encontrada</h3>
          <p className="mt-1 text-sm text-slate-500">As importações iniciadas aparecerão aqui.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {jobs.map(job => (
            <div key={job.id} className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-sm">
              <div 
                className="p-4 flex items-center justify-between cursor-pointer hover:bg-slate-50 transition-colors"
                onClick={() => setSelectedJob(selectedJob === job.id ? null : job.id)}
              >
                <div className="flex items-center gap-4 flex-1">
                  <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600 shrink-0">
                    <FileText size={20} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                      <h3 className="text-sm font-semibold text-slate-900 truncate">Importação {job.id.split('-')[0]}</h3>
                      {getStatusBadge(job.status)}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-slate-500">
                      <span className="flex items-center gap-1"><Clock size={12} /> {new Date(job.createdAt).toLocaleString()}</span>
                      <span>Progresso: {job.progress} / {job.total} ({(job.progress / job.total * 100).toFixed(1)}%)</span>
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center gap-3">
                  {(job.status === 'running' || job.status === 'pending') && (
                    <button 
                      onClick={(e) => { e.stopPropagation(); handleStop(job.id); }}
                      className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      title="Parar Importação"
                    >
                      <Square size={18} />
                    </button>
                  )}
                  {(job.status === 'paused' || job.status === 'failed') && (
                    <button 
                      onClick={(e) => { e.stopPropagation(); handleResume(job.id); }}
                      className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                      title="Retomar Importação"
                    >
                      <Play size={18} />
                    </button>
                  )}
                  {selectedJob === job.id ? <ChevronUp size={20} className="text-slate-400" /> : <ChevronDown size={20} className="text-slate-400" />}
                </div>
              </div>

              {/* Progress Bar */}
              <div className="h-1.5 w-full bg-slate-100">
                <div 
                  className={`h-full transition-all duration-500 ${
                    job.status === 'failed' ? 'bg-red-500' : 
                    job.status === 'completed' ? 'bg-emerald-500' : 
                    job.status === 'paused' ? 'bg-amber-500' : 'bg-indigo-600'
                  }`}
                  style={{ width: `${(job.progress / job.total) * 100}%` }}
                ></div>
              </div>

              {/* Details Panel */}
              {selectedJob === job.id && jobDetails && (
                <div className="p-4 bg-slate-50 border-t border-slate-200">
                  <div className="bg-slate-900 rounded-xl p-4 overflow-hidden flex flex-col max-h-[400px]">
                    <div className="flex items-center gap-2 mb-3 pb-3 border-b border-slate-800">
                      <div className="w-3 h-3 rounded-full bg-red-500"></div>
                      <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                      <div className="w-3 h-3 rounded-full bg-emerald-500"></div>
                      <span className="ml-2 text-xs font-mono text-slate-400">logs da importação</span>
                    </div>
                    
                    <div className="flex-1 overflow-y-auto font-mono text-xs space-y-1.5 pr-2 custom-scrollbar">
                      {jobDetails.logs && jobDetails.logs.length > 0 ? (
                        jobDetails.logs.map((log: any, i: number) => (
                          <div key={i} className={`flex flex-col gap-1 ${
                            log.type === 'error' ? 'text-red-400' : 
                            log.type === 'success' ? 'text-emerald-400' : 
                            'text-slate-300'
                          }`}>
                            <div className="flex gap-3">
                              <span className="text-slate-500 shrink-0">[{log.time}]</span>
                              <span className="break-all">{log.message}</span>
                            </div>
                            {log.details && (
                              <details className="ml-14 mt-1">
                                <summary className="cursor-pointer text-[10px] opacity-80 hover:opacity-100 uppercase tracking-wider font-semibold">Ver detalhes do erro</summary>
                                <pre className="mt-2 p-3 bg-slate-950 rounded-lg text-[10px] overflow-x-auto border border-slate-800 shadow-inner custom-scrollbar">
                                  {typeof log.details === 'string' ? log.details : JSON.stringify(log.details, null, 2)}
                                </pre>
                              </details>
                            )}
                          </div>
                        ))
                      ) : (
                        <div className="text-slate-500 italic">Nenhum log disponível.</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
