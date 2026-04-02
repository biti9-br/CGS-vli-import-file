/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { Upload, Settings, FileText, Play, CheckCircle, AlertCircle, Pause, RefreshCw, Download, FileSpreadsheet, ChevronRight, ChevronLeft, History as HistoryIcon, X, Trash2, HelpCircle, Info } from 'lucide-react';

import AdminConfig from './components/AdminConfig';
import JobsDashboard from './components/JobsDashboard';

type Step = 'upload' | 'mapping' | 'preview' | 'import';

interface MappedData {
  reference: string;
  location?: string;
  [key: string]: any;
}

interface LogEntry {
  type: 'info' | 'success' | 'error';
  message: string;
  time: string;
}

interface ImportHistory {
  id: string;
  date: string;
  fileName: string;
  total: number;
  processed: number;
  status: 'completed' | 'paused' | 'error';
  logs?: LogEntry[];
}

interface ValidationError {
  row: number;
  reference: string;
  type: 'column_mismatch' | 'delimiter_risk';
  message: string;
}

interface ModalConfig {
  isOpen: boolean;
  title: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'confirm';
  onConfirm?: () => void;
}

const getErrorMessage = (status: number): string => {
  switch (status) {
    case 400: return "An attempt was made to access an SSL-only API endpoint via vanilla HTTP. / A required parameter was missing or contained an invalid value.";
    case 401: return "An invalid Cargosnap API token was supplied or the Cargosnap API token was missing.";
    case 404: return "An invalid or unknown API resource was invoked.";
    case 405: return "An invalid HTTP request method was used to access an API resource.";
    case 422: return "A required parameter was missing or contained an invalid value.";
    case 500: return "A problem has occurred with the Cargosnap API.";
    case 503: return "A problem has occurred with the Cargosnap API.";
    default: return "";
  }
};

export default function App() {
  const [currentStep, setCurrentStep] = useState<Step>('upload');
  const [isLoading, setIsLoading] = useState(false);
  const isAdmin = window.location.pathname === '/admin';
  const [adminTab, setAdminTab] = useState<'config' | 'logs'>('config');
  const [userTab, setUserTab] = useState<'import' | 'jobs'>('import');
  
  // Modal State
  const [modal, setModal] = useState<ModalConfig>({ isOpen: false, title: '', message: '', type: 'info' });

  const showModal = (title: string, message: string, type: 'info' | 'success' | 'error' = 'info') => {
    setModal({ isOpen: true, title, message, type });
  };

  const showConfirm = (title: string, message: string, onConfirm: () => void) => {
    setModal({ isOpen: true, title, message, type: 'confirm', onConfirm });
  };

  const closeModal = () => setModal(prev => ({ ...prev, isOpen: false }));

  // File Data
  const [fileName, setFileName] = useState<string>('');
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawData, setRawData] = useState<any[]>([]);
  const [templateSampleData, setTemplateSampleData] = useState<any[]>([]);
  const [templateFileBase64, setTemplateFileBase64] = useState<string>('');
  
  // Mapping Data
  const [referenceColumn, setReferenceColumn] = useState<string>('');
  const [locationId, setLocationId] = useState<string>('');
  const [locationColumn, setLocationColumn] = useState<string>('');
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  
  // Processed Data
  const [processedData, setProcessedData] = useState<MappedData[]>([]);
  const [csvContent, setCsvContent] = useState<string>('');
  const [inconsistencies, setInconsistencies] = useState<any[]>([]);
  
  // Import Simulation State
  const [apiToken, setApiToken] = useState<string>('');
  const [closeExisting, setCloseExisting] = useState<boolean>(false);
  const [importStatus, setImportStatus] = useState<'idle' | 'running' | 'paused' | 'completed'>('idle');
  const [progress, setProgress] = useState<number>(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [currentImportId, setCurrentImportId] = useState<string>('');
  const [previewIndex, setPreviewIndex] = useState<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // History & Persistence State
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ImportHistory[]>([]);
  const [selectedHistoryLogs, setSelectedHistoryLogs] = useState<LogEntry[] | null>(null);

  // System Logs State
  const [systemLogs, setSystemLogs] = useState<any[]>([]);
  const [logFilterKeyword, setLogFilterKeyword] = useState('');
  const [logFilterDate, setLogFilterDate] = useState('');

  const fetchSystemLogs = async () => {
    try {
      const response = await fetch('/api/logs');
      const data = await response.json();
      setSystemLogs(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Failed to fetch system logs', e);
      setSystemLogs([]);
    }
  };

  useEffect(() => {
    if (isAdmin && adminTab === 'logs') {
      fetchSystemLogs();
    }
  }, [isAdmin, adminTab]);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await fetch('/api/config');
        const config = await response.json();
        if (config) {
          setReferenceColumn(config.referenceColumn || '');
          setLocationId(config.locationId || '');
          setLocationColumn(config.locationColumn || '');
          setColumnMapping(config.columnMapping || {});
          setRawHeaders(config.rawHeaders || []);
          setFileName(config.fileName || '');
          if (config.templateFileBase64) {
            setTemplateFileBase64(config.templateFileBase64);
          }
          if (config.sampleData) {
            setTemplateSampleData(config.sampleData);
          }
        }
      } catch (e) {
        console.error("Erro ao buscar configuração do backend:", e);
        // Fallback to localStorage if backend fails
        const savedGlobalMapping = localStorage.getItem('cargosnap_global_mapping');
        if (savedGlobalMapping) {
          try {
            const { ref, loc, locCol, mapping } = JSON.parse(savedGlobalMapping);
            setReferenceColumn(ref);
            setLocationId(loc || '');
            setLocationColumn(locCol || '');
            setColumnMapping(mapping);
          } catch (e) {}
        }
      }
    };

    fetchConfig();

    const savedHistory = localStorage.getItem('cargosnap_history');
    if (savedHistory) {
      try { setHistory(JSON.parse(savedHistory)); } catch (e) {}
    }

    const savedSession = localStorage.getItem('cargosnap_current_session');
    if (savedSession) {
      try {
        const session = JSON.parse(savedSession);
        if (session && session.status !== 'completed' && session.processedData?.length > 0) {
          setProcessedData(session.processedData);
          setProgress(session.progress);
          setFileName(session.fileName);
          setImportStatus(session.status);
          
          const csv = Papa.unparse(session.processedData, {
            quotes: false,
            quoteChar: '"',
            escapeChar: '"',
            delimiter: ";",
            header: true,
            newline: "\r\n"
          });
          setCsvContent(csv);
          
          setCurrentStep('import');
          setLogs([{ type: 'info', message: 'Sessão anterior recuperada. Pronto para continuar.', time: new Date().toLocaleTimeString() }]);
        }
      } catch (e) {}
    }
  }, []);

  useEffect(() => {
    if (processedData.length > 0) {
      const errors: ValidationError[] = [];
      const headers = Object.keys(processedData[0]);
      const expectedColumnCount = headers.length;

      processedData.forEach((row, index) => {
        // 1. Check for missing fields or extra fields (if PapaParse added them)
        const rowKeys = Object.keys(row);
        const rowValues = Object.values(row);
        
        // Check if any expected header is missing value in this row
        const missingHeaders = headers.filter(h => row[h] === undefined || row[h] === null);
        if (missingHeaders.length > 0) {
          errors.push({
            row: index + 1,
            reference: row.reference || 'N/A',
            type: 'column_mismatch',
            message: `Campos ausentes: ${missingHeaders.join(', ')}`
          });
        }

        // Check for extra fields (PapaParse puts them in __parsed_extra)
        if ((row as any).__parsed_extra) {
          errors.push({
            row: index + 1,
            reference: row.reference || 'N/A',
            type: 'column_mismatch',
            message: `Linha contém mais colunas do que o cabeçalho.`
          });
        }

        // 2. Check for delimiters in fields that might cause issues
        headers.forEach(header => {
          const value = String(row[header] || '');
          if (value.includes(',') || value.includes(';') || value.includes('\n') || value.includes('\r')) {
            errors.push({
              row: index + 1,
              reference: row.reference || 'N/A',
              type: 'delimiter_risk',
              message: `Campo "${header}" contém caracteres de risco (vírgula, ponto-e-vírgula ou quebra de linha).`
            });
          }
        });
      });

      // Limit to first 100 errors to avoid UI lag
      setValidationErrors(errors.slice(0, 100));
    } else {
      setValidationErrors([]);
    }
  }, [processedData]);

  const saveSession = (currentProgress: number, status: 'idle' | 'running' | 'paused' | 'completed') => {
    try {
      localStorage.setItem('cargosnap_current_session', JSON.stringify({
        processedData,
        progress: currentProgress,
        fileName,
        status
      }));
    } catch (e) {
      console.warn("Não foi possível salvar a sessão no LocalStorage (limite excedido).");
    }
  };

  const saveToHistory = (finalProgress: number, status: 'completed' | 'paused' | 'error', currentLogs: LogEntry[] = logs) => {
    const newEntry: ImportHistory = {
      id: Date.now().toString(),
      date: new Date().toLocaleString(),
      fileName: fileName || 'Upload_Manual.csv',
      total: processedData.length,
      processed: finalProgress,
      status,
      logs: currentLogs
    };
    const updated = [newEntry, ...history].slice(0, 50);
    setHistory(updated);
    localStorage.setItem('cargosnap_history', JSON.stringify(updated));
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem('cargosnap_history');
  };

  const steps = [
    { id: 'upload', title: '1. Upload', icon: <Upload size={18} /> },
    { id: 'preview', title: '2. Preview', icon: <FileText size={18} /> },
    { id: 'import', title: '3. Importação', icon: <Play size={18} /> },
  ];

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsLoading(true);
    setFileName(file.name);
    const isCsv = file.name.toLowerCase().endsWith('.csv');

    if (isCsv) {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          if (results.data && results.data.length > 0) {
            const headers = Object.keys(results.data[0] as object);
            setRawHeaders(headers);
            setRawData(results.data);

            // Check if it's already a processed CSV (has 'reference' column)
            const hasReference = headers.includes('reference');
            if (hasReference) {
              const errors: any[] = [];
              const deduplicated = new Map<string, MappedData>();
              
              results.data.forEach((row: any, index: number) => {
                const rowNumber = index + 2;
                const refValue = String(row['reference'] || '').trim();
                
                if (!refValue) {
                  errors.push({
                    row: rowNumber,
                    reference: 'N/A',
                    error: 'Referência vazia',
                    details: 'A coluna "reference" está vazia.'
                  });
                  return;
                }
                
                if (deduplicated.has(refValue)) {
                  errors.push({
                    row: rowNumber,
                    reference: refValue,
                    error: 'Referência duplicada',
                    details: `A referência "${refValue}" já apareceu em uma linha anterior.`
                  });
                }
                
                deduplicated.set(refValue, row as MappedData);
              });
              
              setInconsistencies(errors);
              const finalData = Array.from(deduplicated.values());
              setProcessedData(finalData);
              
              const csv = Papa.unparse(finalData, {
                quotes: false,
                quoteChar: '"',
                escapeChar: '"',
                delimiter: ";",
                header: true,
                newline: "\r\n"
              });
              setCsvContent(csv);
              addLog('info', `Arquivo carregado pelo usuário: ${file.name} (${finalData.length} registros válidos).`);
              setCurrentStep('preview');
              setIsLoading(false);
            } else {
              // Raw CSV, apply mapping
              addLog('info', `Arquivo carregado pelo usuário: ${file.name}. Aplicando mapeamento...`);
              processExcelData(results.data, headers);
              setIsLoading(false);
            }
          }
        },
        error: (err) => {
          console.error('CSV Parse Error:', err);
          setIsLoading(false);
          showModal('Erro', 'Falha ao processar arquivo CSV.', 'error');
        }
      });
    } else {
      // Excel Import
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const bstr = evt.target?.result;
          const wb = XLSX.read(bstr, { type: 'binary' });
          const wsname = wb.SheetNames[0];
          const ws = wb.Sheets[wsname];
          const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
          
          if (data.length > 0) {
            const headers = Object.keys(data[0] as object);
            setRawHeaders(headers);
            setRawData(data);
            
            addLog('info', `Arquivo Excel carregado pelo usuário: ${file.name}. Aplicando mapeamento...`);
            processExcelData(data, headers);
          }
        } catch (err) {
          console.error('Excel Parse Error:', err);
          showModal('Erro', 'Falha ao processar arquivo Excel.', 'error');
        } finally {
          setIsLoading(false);
        }
      };
      reader.onerror = () => {
        setIsLoading(false);
        showModal('Erro', 'Erro ao ler arquivo.', 'error');
      };
      reader.readAsBinaryString(file);
    }
  };

  const processExcelData = (data: any[], headers: string[]) => {
    // Load fresh mapping from state or backend
    let refCol = referenceColumn;
    let locId = locationId;
    let locCol = locationColumn;
    let mapping: Record<string, string> = columnMapping;
    
    if (!refCol) {
      showModal('Atenção', 'Configuração de De-Para não encontrada. Por favor, acesse /admin para configurar.', 'error');
      setCurrentStep('upload');
      return;
    }

    const deduplicated = new Map<string, MappedData>();
    const errors: any[] = [];

    data.forEach((row, index) => {
      const rowNumber = index + 2;
      const refValue = String(row[refCol] || '').trim();
      
      if (!refValue) {
        errors.push({
          row: rowNumber,
          reference: 'N/A',
          error: 'Coluna de referência vazia',
          details: `A coluna "${refCol}" está vazia nesta linha.`
        });
        return;
      }

      if (deduplicated.has(refValue)) {
        errors.push({
          row: rowNumber,
          reference: refValue,
          error: 'Referência duplicada',
          details: `A referência "${refValue}" já apareceu em uma linha anterior. Apenas a última será considerada.`
        });
      }

      const mappedRow: MappedData = { reference: refValue };
      
      // Add optional location
      if (locId && locId.trim() !== '') {
        mappedRow.location = locId.trim();
      } else if (locCol && row[locCol] && String(row[locCol]).trim() !== '') {
        mappedRow.location = String(row[locCol]).trim();
      }
      
      Object.entries(mapping).forEach(([header, targetId]) => {
        if (targetId && typeof targetId === 'string' && targetId.trim() !== '') {
          mappedRow[targetId] = String(row[header] || '').trim();
        }
      });

      deduplicated.set(refValue, mappedRow);
    });

    setInconsistencies(errors);
    const finalData = Array.from(deduplicated.values());
    setProcessedData(finalData);

    if (errors.length > 0) {
      addLog('error', `CSV processado com ${errors.length} inconsistências.`, errors);
    } else {
      addLog('success', `CSV processado com sucesso. ${finalData.length} registros válidos.`);
    }

    const csv = Papa.unparse(finalData, {
      quotes: false,
      quoteChar: '"',
      escapeChar: '"',
      delimiter: ";",
      header: true,
      newline: "\r\n"
    });
    
    setCsvContent(csv);
    setCurrentStep('preview');
  };

  const downloadCsv = () => {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `cargosnap_import_${new Date().getTime()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    addLog('info', `CSV gerado e baixado com ${processedData.length} registros.`);
  };

  const downloadTemplate = async () => {
    if (rawHeaders.length === 0) {
      showModal('Atenção', 'Nenhum template configurado. Peça ao administrador para configurar o De-Para.', 'error');
      return;
    }

    try {
      const response = await fetch('/api/template/download');
      if (response.ok) {
        const blob = await response.blob();
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.href = url;
        link.download = fileName || 'template_importacao.xlsx';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        addLog('info', 'Template baixado pelo usuário (Arquivo do Servidor).');
        return;
      }
    } catch (error) {
      console.error("Error downloading template from server:", error);
    }

    // Fallback to base64 or CSV generation if server download fails
    if (templateFileBase64) {
      try {
        // Extract the base64 data part
        const base64Data = templateFileBase64.split(';base64,').pop();
        if (!base64Data) throw new Error("Invalid base64 string");

        // Convert base64 to Blob
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        
        // Determine mime type from base64 string or default to xlsx
        let mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        const mimeMatch = templateFileBase64.match(/^data:(.*?);base64,/);
        if (mimeMatch && mimeMatch[1]) {
          mimeType = mimeMatch[1];
        }

        const blob = new Blob([byteArray], { type: mimeType });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.href = url;
        link.download = fileName || 'template_importacao.xlsx';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        addLog('info', 'Template baixado pelo usuário (Arquivo Original).');
        return;
      } catch (error) {
        console.error("Error downloading base64 file:", error);
        // Fallback to CSV generation if base64 decoding fails
      }
    }

    const csv = Papa.unparse({
      fields: rawHeaders,
      data: templateSampleData.length > 0 ? templateSampleData : []
    }, {
      quotes: false,
      quoteChar: '"',
      escapeChar: '"',
      delimiter: ";",
      newline: "\r\n"
    });
    
    // Add BOM for Excel compatibility
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", (fileName ? fileName.replace(/\.[^/.]+$/, "") : 'template') + '.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    addLog('info', 'Template baixado pelo usuário (CSV Gerado).');
  };

  const addLog = async (type: 'info' | 'success' | 'error', message: string, details?: any) => {
    const logEntry = { type, message, time: new Date().toLocaleTimeString(), details };
    setLogs(prev => [logEntry, ...prev]);
    try {
      await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(logEntry)
      });
    } catch (e) {
      console.error('Failed to save log to backend', e);
    }
  };

  // Lógica principal de Importação
  const startImport = async () => {
    if (!apiToken) {
      showModal('Atenção', 'Por favor, insira o Token da API.', 'error');
      return;
    }

    // Validação do formato do Token (Mínimo 16 caracteres, sem espaços)
    const tokenRegex = /^\S{16,}$/;
    if (!tokenRegex.test(apiToken)) {
      showModal('Atenção', 'Formato de Token inválido. O token deve conter pelo menos 16 caracteres e não possuir espaços.', 'error');
      return;
    }
    
    setIsLoading(true);
    try {
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: processedData,
          config: {
            apiToken,
            closeExisting
          }
        })
      });
      
      if (!response.ok) throw new Error('Falha ao iniciar importação');
      
      showModal('Sucesso', 'Importação enviada para processamento em segundo plano.', 'success');
      setUserTab('jobs');
      
      // Clear current session
      localStorage.removeItem('importSession');
      setProcessedData([]);
      setCurrentStep('upload');
      
    } catch (error) {
      showModal('Erro', 'Não foi possível iniciar a importação.', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const pauseImport = () => {
    // This is now handled in the JobsDashboard
  };

  const resetImport = () => {
    pauseImport();
    if (progress > 0 && importStatus !== 'completed') {
      saveToHistory(progress, 'paused', logs);
    }
    setImportStatus('idle');
    setProgress(0);
    setLogs([]);
    localStorage.removeItem('cargosnap_current_session');
    setCurrentStep('upload');
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img 
              src="https://developer.cargosnap.com/img/Cargosnap_logo_black.png" 
              alt="Cargosnap Logo" 
              className="h-6 object-contain"
              referrerPolicy="no-referrer"
            />
            <div className="h-5 w-px bg-slate-300 mx-1"></div>
            <h1 className="text-xl font-bold tracking-tight text-slate-800">
              {isAdmin ? 'File Importer - Admin' : 'File Importer'}
            </h1>
          </div>
          <div className="flex items-center gap-4">
            {isAdmin ? (
              <div className="flex bg-slate-100 p-1 rounded-lg">
                <button 
                  onClick={() => setAdminTab('config')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${adminTab === 'config' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Configuração
                </button>
                <button 
                  onClick={() => setAdminTab('logs')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${adminTab === 'logs' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Logs do Sistema
                </button>
              </div>
            ) : (
              <div className="flex bg-slate-100 p-1 rounded-lg">
                <button 
                  onClick={() => setUserTab('import')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${userTab === 'import' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Nova Importação
                </button>
                <button 
                  onClick={() => setUserTab('jobs')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${userTab === 'jobs' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Importações
                </button>
              </div>
            )}
            {!isAdmin && (
              <div className="text-sm text-slate-500 hidden md:block border-l pl-4 border-slate-200">
                Importador P&T
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {isAdmin && adminTab === 'logs' ? (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 md:p-8 min-h-[500px] animate-in fade-in duration-300">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
                <HistoryIcon className="text-indigo-600" />
                Logs do Sistema
              </h2>
              <button 
                onClick={fetchSystemLogs}
                className="flex items-center gap-2 px-3 py-1.5 text-sm text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
              >
                <RefreshCw size={16} />
                Atualizar
              </button>
            </div>

            <div className="flex flex-wrap gap-4 mb-6 bg-slate-50 p-4 rounded-xl border border-slate-200">
              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase tracking-wider">Palavra-chave / Reference</label>
                <input 
                  type="text" 
                  placeholder="Buscar nos logs..."
                  className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  value={logFilterKeyword}
                  onChange={(e) => setLogFilterKeyword(e.target.value)}
                />
              </div>
              <div className="w-full md:w-auto">
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase tracking-wider">Data</label>
                <input 
                  type="date" 
                  className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  value={logFilterDate}
                  onChange={(e) => setLogFilterDate(e.target.value)}
                />
              </div>
            </div>

            {systemLogs.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                <HistoryIcon size={48} className="mx-auto mb-4 opacity-20" />
                <p>Nenhum log de sistema encontrado.</p>
              </div>
            ) : (
              <div className="bg-slate-900 rounded-xl overflow-hidden shadow-inner border border-slate-800">
                <div className="max-h-[600px] overflow-y-auto p-4 font-mono text-xs custom-scrollbar space-y-2">
                  {systemLogs
                    .filter(log => {
                      if (logFilterKeyword) {
                        const keyword = logFilterKeyword.toLowerCase();
                        if (!log.message?.toLowerCase().includes(keyword) && 
                            !(log.details && JSON.stringify(log.details).toLowerCase().includes(keyword))) {
                          return false;
                        }
                      }
                      if (logFilterDate) {
                        if (!log.timestamp?.startsWith(logFilterDate)) {
                          return false;
                        }
                      }
                      return true;
                    })
                    .map((log, i) => (
                      <div key={i} className={`flex flex-col gap-1 p-2 rounded-lg ${
                        log.type === 'error' ? 'bg-red-950/30' : 
                        log.type === 'success' ? 'bg-emerald-950/30' : 
                        'hover:bg-slate-800/50'
                      }`}>
                        <div className={`flex gap-3 ${
                          log.type === 'error' ? 'text-red-400' : 
                          log.type === 'success' ? 'text-emerald-400' : 
                          'text-slate-300'
                        }`}>
                          <span className="text-slate-500 shrink-0">[{log.timestamp ? new Date(log.timestamp).toLocaleString() : 'N/A'}]</span>
                          <span className="break-all font-medium">{log.message || 'Log sem mensagem'}</span>
                        </div>
                        {log.details && (
                          <div className="ml-36 pl-4 border-l border-slate-700 text-slate-400 mt-1 whitespace-pre-wrap overflow-x-auto">
                            {typeof log.details === 'string' ? log.details : JSON.stringify(log.details, null, 2)}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        ) : isAdmin && adminTab === 'config' ? (
          <AdminConfig showModal={showModal} showConfirm={showConfirm} />
        ) : !isAdmin && userTab === 'jobs' ? (
          <JobsDashboard showModal={showModal} showConfirm={showConfirm} />
        ) : (
          <>
            {/* Stepper */}
            <div className="flex items-center justify-between mb-8 overflow-x-auto pb-4">
              <div className="flex items-center">
                {steps.map((step, index) => {
                  const isActive = currentStep === step.id;
                  const isPast = steps.findIndex(s => s.id === currentStep) > index;
                  
                  return (
                    <div key={step.id} className="flex items-center">
                      <div className={`flex items-center justify-center w-10 h-10 rounded-full border-2 transition-colors ${isActive ? 'border-indigo-600 bg-indigo-50 text-indigo-600' : isPast ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-200 text-slate-400 bg-white'}`}>
                        {isPast ? <CheckCircle size={20} /> : step.icon}
                      </div>
                      <span className={`ml-3 font-medium ${isActive ? 'text-indigo-900' : isPast ? 'text-slate-900' : 'text-slate-400'}`}>
                        {step.title}
                      </span>
                      {index < steps.length - 1 && (
                        <div className={`w-16 h-0.5 mx-4 ${isPast ? 'bg-emerald-500' : 'bg-slate-200'}`} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Content Area */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 md:p-8 min-h-[500px]">
          
          {/* STEP 1: UPLOAD */}
          {currentStep === 'upload' && (
            <div className="flex flex-col items-center justify-center h-full py-12">
              <div className="w-full max-w-2xl">
                <div className="flex flex-col items-center justify-center p-10 border-2 border-dashed border-slate-300 rounded-2xl bg-slate-50 hover:bg-slate-100 transition-colors cursor-pointer relative group">
                  <input 
                    id="import-file-upload"
                    type="file" 
                    accept=".xlsx,.xls,.csv" 
                    onChange={handleFileUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div className="bg-white p-4 rounded-full shadow-sm mb-4 group-hover:scale-110 transition-transform">
                    <FileSpreadsheet size={32} className="text-indigo-600" />
                  </div>
                  <h3 className="text-lg font-semibold text-slate-700 mb-1">
                    Upload da Planilha (Excel/CSV)
                  </h3>
                  <p className="text-slate-500 text-sm text-center max-w-sm">
                    Arraste ou clique para selecionar o arquivo com os dados a serem importados.
                  </p>
                </div>
                
                {rawHeaders.length > 0 && (
                  <div className="mt-6 flex justify-center">
                    <button 
                      onClick={downloadTemplate}
                      className="flex items-center gap-2 px-6 py-2.5 bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 hover:text-indigo-600 rounded-xl font-medium transition-colors shadow-sm"
                    >
                      <Download size={18} />
                      Baixar Template Configurado
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STEP 3: PREVIEW */}
          {currentStep === 'preview' && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-4">
                  <button 
                    onClick={() => setCurrentStep('upload')}
                    className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                    title="Voltar"
                  >
                    <ChevronLeft size={20} />
                  </button>
                  <div>
                    <h2 className="text-xl font-semibold">Pré-visualização do CSV</h2>
                    <p className="text-slate-500 text-sm mt-1">
                      {processedData.length} registros únicos prontos para importação.
                    </p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button 
                    onClick={downloadCsv}
                    className="bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-colors"
                  >
                    <Download size={18} />
                    Baixar CSV
                  </button>
                  <button 
                    onClick={() => setCurrentStep('import')}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-xl font-medium flex items-center gap-2 transition-colors"
                  >
                    Ir para Importação
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>

              <div className="bg-slate-900 rounded-xl p-4 overflow-x-auto">
                <pre className="text-emerald-400 font-mono text-sm whitespace-pre-wrap">
                  {csvContent.split('\n').slice(0, 10).join('\n')}
                  {csvContent.split('\n').length > 10 && '\n... (mais registros)'}
                </pre>
              </div>

              {/* Validation Results */}
              {(inconsistencies.length > 0 || validationErrors.length > 0) && (
                <div className="mt-6 bg-red-50 border border-red-200 rounded-xl overflow-hidden">
                  <div className="p-5 border-b border-red-200">
                    <div className="flex items-center gap-2 text-red-800 font-semibold mb-1">
                      <AlertCircle size={20} />
                      Avisos e Inconsistências ({inconsistencies.length + validationErrors.length})
                    </div>
                    <p className="text-sm text-red-600">
                      Verifique os detalhes abaixo. Algumas inconsistências foram ignoradas na geração do CSV, outras podem causar falhas na importação.
                    </p>
                  </div>
                  <div className="max-h-80 overflow-y-auto custom-scrollbar">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-red-100/50 sticky top-0 z-10">
                        <tr>
                          <th className="px-5 py-3 font-semibold text-red-800 border-b border-red-200 w-20">Linha</th>
                          <th className="px-5 py-3 font-semibold text-red-800 border-b border-red-200 w-32">Referência</th>
                          <th className="px-5 py-3 font-semibold text-red-800 border-b border-red-200 w-48">Erro</th>
                          <th className="px-5 py-3 font-semibold text-red-800 border-b border-red-200">Detalhes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-red-100">
                        {[
                          ...inconsistencies,
                          ...validationErrors.map(e => ({
                            row: e.row,
                            reference: e.reference,
                            error: e.type === 'column_mismatch' ? 'Inconsistência de Colunas' : 'Risco de Delimitador',
                            details: e.message
                          }))
                        ].sort((a, b) => a.row - b.row).map((err, i) => (
                          <tr key={i} className="hover:bg-red-100/30 transition-colors">
                            <td className="px-5 py-3 font-mono text-red-700">{err.row}</td>
                            <td className="px-5 py-3 font-mono text-red-700 truncate max-w-[8rem]" title={err.reference}>{err.reference}</td>
                            <td className="px-5 py-3 font-medium text-red-800">{err.error}</td>
                            <td className="px-5 py-3 text-red-700">{err.details}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="mt-6 bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3">
                <AlertCircle className="text-amber-600 shrink-0 mt-0.5" size={20} />
                <div>
                  <h4 className="font-medium text-amber-900">Correção de Aspas Duplas Aplicada</h4>
                  <p className="text-sm text-amber-700 mt-1">
                    O parser nativo do script original possuía um bug ao tratar aspas duplas internas. 
                    Este CSV foi gerado utilizando o padrão RFC 4180, escapando aspas corretamente (`""`), 
                    garantindo que campos como endereços não quebrem a importação.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* STEP 4: IMPORT SIMULATOR */}
          {currentStep === 'import' && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-center gap-4 mb-6">
                <button 
                  onClick={() => setCurrentStep('preview')}
                  className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                  title="Voltar para Preview"
                  disabled={importStatus === 'running'}
                >
                  <ChevronLeft size={20} />
                </button>
                <h2 className="text-xl font-semibold">Importação</h2>
              </div>
              
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                
                {/* Config Panel */}
                <div className="lg:col-span-1 space-y-6">
                  <div>
                    <h2 className="text-xl font-semibold mb-4">Configuração da API</h2>
                    
                    <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">API Token</label>
                      <input 
                        type="password" 
                        placeholder="Insira o token do Cargosnap"
                        className="w-full bg-white border border-slate-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-indigo-500 outline-none"
                        value={apiToken}
                        onChange={(e) => setApiToken(e.target.value)}
                        disabled={importStatus === 'running'}
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <input 
                        type="checkbox" 
                        id="closeExisting"
                        className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                        checked={closeExisting}
                        onChange={(e) => setCloseExisting(e.target.checked)}
                        disabled={importStatus === 'running'}
                      />
                      <label htmlFor="closeExisting" className="text-sm font-medium text-slate-700">
                        Fechar registros existentes (closeExisting)
                      </label>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-200">
                  <div className="flex flex-col gap-3">
                    {importStatus !== 'running' ? (
                      <button 
                        onClick={startImport}
                        className="w-full bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-3 rounded-xl font-medium flex items-center justify-center gap-2 transition-colors"
                      >
                        <Play size={20} />
                        {importStatus === 'paused' ? 'Retomar Importação' : 'Iniciar Importação'}
                      </button>
                    ) : (
                      <button 
                        onClick={pauseImport}
                        className="w-full bg-amber-500 hover:bg-amber-600 text-white px-4 py-3 rounded-xl font-medium flex items-center justify-center gap-2 transition-colors"
                      >
                        <Pause size={20} />
                        Pausar Importação
                      </button>
                    )}
                    
                    {(importStatus === 'paused' || importStatus === 'completed') && (
                      <button 
                        onClick={resetImport}
                        className="w-full bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-xl font-medium flex items-center justify-center gap-2 transition-colors"
                      >
                        <RefreshCw size={18} />
                        Reiniciar
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Console & Progress */}
              <div className="lg:col-span-2 flex flex-col h-full">
                <div className="mb-4">
                  <div className="flex justify-between text-sm font-medium mb-2">
                    <span className="text-slate-700">Progresso</span>
                    <span className="text-indigo-600">{progress} / {processedData.length} ({(progress / processedData.length * 100 || 0).toFixed(1)}%)</span>
                  </div>
                  <div className="w-full bg-slate-200 rounded-full h-3 overflow-hidden">
                    <div 
                      className="bg-indigo-600 h-3 rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${(progress / processedData.length * 100) || 0}%` }}
                    ></div>
                  </div>
                </div>

                <div className="flex-1 bg-slate-900 rounded-xl p-4 overflow-hidden flex flex-col min-h-[300px]">
                  <div className="flex items-center gap-2 mb-3 pb-3 border-b border-slate-800">
                    <div className="w-3 h-3 rounded-full bg-red-500"></div>
                    <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                    <div className="w-3 h-3 rounded-full bg-emerald-500"></div>
                    <span className="ml-2 text-xs font-mono text-slate-400">cargosnap-import ~ %</span>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto font-mono text-xs space-y-1.5 pr-2 custom-scrollbar">
                    {logs.length === 0 ? (
                      <div className="text-slate-500 italic">Aguardando início da importação...</div>
                    ) : (
                      logs.map((log, i) => (
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
                              <summary className="cursor-pointer text-[10px] opacity-80 hover:opacity-100 uppercase tracking-wider font-semibold">Ver detalhes</summary>
                              <pre className="mt-2 p-3 bg-slate-950 rounded-lg text-[10px] overflow-x-auto border border-slate-800 shadow-inner custom-scrollbar">
                                {typeof log.details === 'string' ? log.details : JSON.stringify(log.details, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* Payload Example Section */}
              {processedData.length > 0 && (
                <div className="lg:col-span-full mt-8 bg-slate-50 border border-slate-200 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2 text-slate-800 font-semibold">
                      <FileText size={20} className="text-indigo-600" />
                      Exemplo de Payload
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-slate-500">Registro:</span>
                      <div className="flex bg-white border border-slate-200 rounded-lg overflow-hidden">
                        {[0, 1, 2].map(idx => (
                          idx < processedData.length && (
                            <button
                              key={idx}
                              onClick={() => setPreviewIndex(idx)}
                              className={`px-3 py-1 text-sm font-medium transition-colors ${previewIndex === idx ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-600' : 'text-slate-600 hover:bg-slate-50'}`}
                            >
                              {idx + 1}
                            </button>
                          )
                        ))}
                      </div>
                    </div>
                  </div>
                  <p className="text-sm text-slate-600 mb-4">
                    Abaixo está a representação exata de como os dados do registro {previewIndex + 1} serão enviados para a API do Cargosnap.
                  </p>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div>
                      <div className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wider">1. Criação do Arquivo (POST /files)</div>
                      <pre className="bg-slate-900 text-emerald-400 p-4 rounded-xl text-xs overflow-x-auto font-mono shadow-inner custom-scrollbar">
{`fetch('https://api.cargosnap.com/api/v2/files?token=${apiToken ? '****************' : '<SEU_TOKEN>'}', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  body: JSON.stringify(${JSON.stringify({
    reference: processedData[previewIndex].reference,
    close: closeExisting ? 1 : 0,
    ...(processedData[previewIndex].location ? { location_id: processedData[previewIndex].location } : {})
  }, null, 4).replace(/\n/g, '\n  ')})
});`}
                      </pre>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wider">2. Atualização de Campos (POST /fields/&#123;ref&#125;)</div>
                      <pre className="bg-slate-900 text-emerald-400 p-4 rounded-xl text-xs overflow-x-auto font-mono shadow-inner custom-scrollbar">
{`fetch('https://api.cargosnap.com/api/v2/fields/${encodeURIComponent(processedData[previewIndex].reference)}?token=${apiToken ? '****************' : '<SEU_TOKEN>'}', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  body: JSON.stringify(${JSON.stringify(
    Object.keys(processedData[previewIndex])
      .filter(k => k !== 'reference' && k !== 'location')
      .filter(k => {
        const val = processedData[previewIndex][k];
        return val !== null && val !== undefined && String(val).trim() !== "";
      })
      .map(k => ({
        id: k,
        value: processedData[previewIndex][k]
      })),
    null, 4
  ).replace(/\n/g, '\n  ')})
});`}
                      </pre>
                    </div>
                  </div>
                </div>
              )}
            </div>
            </div>
          )}
        </div>
        </>
      )}
      </main>
      
      {/* Footer with Readme info */}
      <footer className="max-w-6xl mx-auto px-4 py-8 text-center text-sm text-slate-500">
        <p>Desenvolvido para automação do processo de importação para Cargosnap.</p>
      </footer>

      {/* Custom Modal */}
      {modal.isOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 mb-4">
              {modal.type === 'success' && <CheckCircle className="text-emerald-500" size={24} />}
              {modal.type === 'error' && <AlertCircle className="text-red-500" size={24} />}
              {modal.type === 'info' && <Info className="text-indigo-500" size={24} />}
              {modal.type === 'confirm' && <HelpCircle className="text-amber-500" size={24} />}
              <h3 className="text-xl font-semibold text-slate-800">{modal.title}</h3>
            </div>
            <p className="text-slate-600 mb-6">{modal.message}</p>
            <div className="flex justify-end gap-3">
              {modal.type === 'confirm' ? (
                <>
                  <button 
                    onClick={closeModal}
                    className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg font-medium transition-colors"
                  >
                    Cancelar
                  </button>
                  <button 
                    onClick={() => {
                      if (modal.onConfirm) modal.onConfirm();
                      closeModal();
                    }}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors"
                  >
                    Confirmar
                  </button>
                </>
              ) : (
                <button 
                  onClick={closeModal}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors"
                >
                  OK
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* History Sidebar */}
      {isHistoryOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-sm" onClick={() => setIsHistoryOpen(false)} />
          <div className="relative w-full max-w-sm bg-white h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
            <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <div className="flex items-center gap-2 text-slate-800 font-semibold">
                <HistoryIcon size={18} className="text-indigo-600" />
                Histórico de Importações
              </div>
              <button onClick={() => setIsHistoryOpen(false)} className="text-slate-400 hover:text-slate-700 transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <div className="p-5 overflow-y-auto flex-1 custom-scrollbar">
              {history.length === 0 ? (
                <div className="text-center text-slate-500 mt-10 flex flex-col items-center">
                  <HistoryIcon size={48} className="text-slate-200 mb-3" />
                  <p>Nenhum histórico encontrado.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {history.map(h => (
                    <div key={h.id} className="p-4 border border-slate-100 rounded-xl shadow-sm hover:shadow-md transition-shadow bg-white">
                      <div className="font-medium text-slate-800 truncate mb-1" title={h.fileName}>{h.fileName}</div>
                      <div className="text-slate-500 text-xs mb-3">{h.date}</div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-medium text-slate-600">
                          {h.processed} / {h.total} <span className="text-xs font-normal text-slate-400">registros</span>
                        </span>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                          h.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : 
                          h.status === 'error' ? 'bg-red-100 text-red-700' : 
                          'bg-amber-100 text-amber-700'
                        }`}>
                          {h.status === 'completed' ? 'Concluído' : h.status === 'paused' ? 'Pausado' : 'Erro'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            {history.length > 0 && (
              <div className="p-4 border-t border-slate-100 bg-slate-50">
                <button 
                  onClick={clearHistory}
                  className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                >
                  <Trash2 size={16} />
                  Limpar Histórico
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Loading Overlay */}
      {isLoading && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100] flex flex-col items-center justify-center p-6 animate-in fade-in duration-300">
          <div className="relative">
            <div className="w-20 h-20 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin"></div>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-10 h-10 border-4 border-indigo-500/10 border-b-indigo-500 rounded-full animate-spin opacity-50" style={{ animationDirection: 'reverse', animationDuration: '3s' }}></div>
            </div>
          </div>
          <div className="mt-8 text-center">
            <h3 className="text-xl font-bold text-white mb-2 tracking-tight">Processando</h3>
            <p className="text-indigo-200/70 text-sm font-medium animate-pulse">Por favor, aguarde um momento...</p>
          </div>
        </div>
      )}
    </div>
  );
}

