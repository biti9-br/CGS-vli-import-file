import React, { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { Upload, Settings, FileSpreadsheet, ChevronLeft, CheckCircle, HelpCircle, Info } from 'lucide-react';

interface AdminConfigProps {
  showModal: (title: string, message: string, type: 'info' | 'success' | 'error') => void;
  showConfirm: (title: string, message: string, onConfirm: () => void) => void;
}

export default function AdminConfig({ showModal, showConfirm }: AdminConfigProps) {
  const [currentStep, setCurrentStep] = useState<'upload' | 'mapping'>('upload');
  const [fileName, setFileName] = useState<string>('');
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawData, setRawData] = useState<any[]>([]);
  const [templateFileBase64, setTemplateFileBase64] = useState<string>('');
  
  const [referenceColumn, setReferenceColumn] = useState<string>('');
  const [locationId, setLocationId] = useState<string>('');
  const [locationColumn, setLocationColumn] = useState<string>('');
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [activeHelp, setActiveHelp] = useState<'reference' | 'location' | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingConfig, setIsFetchingConfig] = useState(true);

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
            setRawData(config.sampleData);
          }
        }
      } catch (e) {
        console.error('Failed to fetch config', e);
      } finally {
        setIsFetchingConfig(false);
      }
    };
    fetchConfig();
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setIsLoading(true);
      setFileName(file.name);
      
      // Read file as base64 for storage
      const base64Reader = new FileReader();
      base64Reader.onload = (evt) => {
        const base64 = evt.target?.result as string;
        setTemplateFileBase64(base64);
      };
      base64Reader.readAsDataURL(file);

      // Read file for parsing
      const reader = new FileReader();
      
      reader.onload = (evt) => {
        try {
          const bstr = evt.target?.result;
          const wb = XLSX.read(bstr, { type: 'binary' });
          const wsname = wb.SheetNames[0];
          const ws = wb.Sheets[wsname];
          const data = XLSX.utils.sheet_to_json(ws);
          
          if (data.length > 0) {
            const headers = Object.keys(data[0] as object);
            setRawHeaders(headers);
            setRawData(data);
            
            if (!referenceColumn) {
              const refCol = headers.find(h => h.toLowerCase().includes('reference') || h.toLowerCase().includes('referencia'));
              if (refCol) setReferenceColumn(refCol);
            }
            setCurrentStep('mapping');
          }
        } catch (err) {
          console.error(err);
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

  const handleMappingChange = (header: string, value: string) => {
    setColumnMapping(prev => ({
      ...prev,
      [header]: value
    }));
  };

  const saveGlobalMapping = async () => {
    setIsLoading(true);
    const config = {
      referenceColumn,
      locationId,
      locationColumn,
      columnMapping,
      rawHeaders,
      fileName,
      sampleData: rawData.slice(0, 5),
      templateFileBase64
    };

    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      
      if (response.ok) {
        localStorage.setItem('cargosnap_global_mapping', JSON.stringify({
          ref: referenceColumn,
          loc: locationId,
          locCol: locationColumn,
          mapping: columnMapping
        }));
        showModal('Sucesso', 'Configuração de De-Para salva com sucesso no backend!', 'success');
        setCurrentStep('upload');
      } else {
        throw new Error("Falha ao salvar no backend");
      }
    } catch (e) {
      console.error(e);
      showModal('Aviso', 'Erro ao salvar no backend. A configuração foi salva apenas localmente.', 'error');
      localStorage.setItem('cargosnap_global_mapping', JSON.stringify({
        ref: referenceColumn,
        loc: locationId,
        locCol: locationColumn,
        mapping: columnMapping
      }));
    } finally {
      setIsLoading(false);
    }
  };

  const deleteGlobalMapping = async () => {
    showConfirm('Confirmar Exclusão', 'Tem certeza que deseja excluir a parametrização atual?', async () => {
      setIsLoading(true);
      try {
        await fetch('/api/config', { method: 'DELETE' });
        localStorage.removeItem('cargosnap_global_mapping');
        setReferenceColumn('');
        setLocationColumn('');
        setColumnMapping({});
        setRawHeaders([]);
        setFileName('');
        setTemplateFileBase64('');
        setCurrentStep('upload');
        showModal('Sucesso', 'Parametrização excluída com sucesso!', 'success');
      } catch (e) {
        console.error(e);
        showModal('Erro', 'Erro ao excluir parametrização.', 'error');
      } finally {
        setIsLoading(false);
      }
    });
  };

  const downloadTemplate = async () => {
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
        return;
      }
    } catch (error) {
      console.error("Error downloading template from server:", error);
    }

    // Fallback to base64 or CSV generation if server download fails
    if (templateFileBase64) {
      try {
        const res = await fetch(templateFileBase64);
        const blob = await res.blob();
        
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.href = url;
        link.download = fileName || 'template_importacao.xlsx';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        return;
      } catch (error) {
        console.error("Error downloading base64 file:", error);
      }
    }

    const csv = Papa.unparse({
      fields: rawHeaders,
      data: rawData.length > 0 ? rawData : []
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
  };

  const steps = [
    { id: 'upload', title: '1. Template', icon: <Upload size={18} /> },
    { id: 'mapping', title: '2. Configurar De-Para', icon: <Settings size={18} /> },
  ];

  return (
    <>
      {/* Stepper */}
      <div className="flex items-center justify-between mb-8 overflow-x-auto pb-4">
        {steps.map((step, index) => {
          const isActive = currentStep === step.id;
          const isPast = steps.findIndex(s => s.id === currentStep) > index;
          
          return (
            <div key={step.id} className="flex items-center">
              <div className={`flex items-center justify-center w-10 h-10 rounded-full border-2 transition-all duration-300 ${
                isActive ? 'border-indigo-600 bg-indigo-50 text-indigo-600 shadow-md scale-110' : 
                isPast ? 'border-indigo-600 bg-indigo-600 text-white' : 
                'border-slate-200 bg-white text-slate-400'
              }`}>
                {step.icon}
              </div>
              <div className="ml-3 hidden sm:block">
                <div className={`text-sm font-semibold ${isActive ? 'text-indigo-900' : isPast ? 'text-slate-800' : 'text-slate-400'}`}>
                  {step.title}
                </div>
              </div>
              {index < steps.length - 1 && (
                <div className={`w-12 sm:w-24 h-1 mx-4 rounded-full transition-colors duration-500 ${
                  isPast ? 'bg-indigo-600' : 'bg-slate-200'
                }`}></div>
              )}
            </div>
          );
        })}
      </div>

      {currentStep === 'upload' && (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 md:p-12 text-center">
            <div 
              className="border-2 border-dashed border-slate-300 rounded-xl p-12 hover:bg-slate-50 hover:border-indigo-400 transition-all cursor-pointer group flex flex-col items-center justify-center"
              onClick={() => document.getElementById('file-upload')?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                  handleFileUpload({ target: { files: e.dataTransfer.files } } as any);
                }
              }}
            >
              <input 
                type="file" 
                id="file-upload" 
                className="hidden" 
                accept=".csv,.xlsx,.xls"
                onChange={handleFileUpload}
              />
              <div className="bg-white p-4 rounded-full shadow-sm mb-4 group-hover:scale-110 transition-transform">
                <FileSpreadsheet size={32} className="text-indigo-600" />
              </div>
              <h3 className="text-lg font-semibold text-slate-700 mb-1">
                Upload do Template (Excel/CSV)
              </h3>
              <p className="text-slate-500 text-sm text-center max-w-sm">
                Arraste ou clique para selecionar o arquivo de template que servirá como base para o De-Para.
              </p>
              <div className="mt-6 flex items-center gap-2 px-4 py-2 bg-amber-50 border border-amber-100 rounded-lg text-amber-700 text-xs font-medium">
                <Info size={14} className="shrink-0" />
                <span>Importante: A planilha deve conter pelo menos um registro de exemplo com todas as células preenchidas para o mapeamento correto.</span>
              </div>
            </div>

            {isFetchingConfig ? (
              <div className="mt-6 p-5 bg-slate-50 border border-slate-200 rounded-xl flex flex-col md:flex-row gap-4 items-center justify-between animate-pulse">
                <div className="space-y-3 w-full md:w-auto">
                  <div className="h-5 bg-slate-200 rounded w-48"></div>
                  <div className="h-4 bg-slate-200 rounded w-36"></div>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-3 w-full md:w-auto">
                  <div className="h-9 bg-slate-200 rounded-lg w-32"></div>
                  <div className="h-9 bg-slate-200 rounded-lg w-20"></div>
                  <div className="h-9 bg-slate-200 rounded-lg w-40"></div>
                </div>
              </div>
            ) : (
              rawHeaders.length > 0 && (
                <div className="mt-6 p-5 bg-indigo-50 border border-indigo-100 rounded-xl flex flex-col md:flex-row gap-4 items-center justify-between">
                  <div className="text-center md:text-left">
                    <h4 className="font-semibold text-indigo-900">Parametrização Ativa</h4>
                    <p className="text-sm text-indigo-700 mt-1 break-all">Template: {fileName}</p>
                  </div>
                  <div className="flex flex-wrap justify-center gap-3">
                    <button 
                      onClick={downloadTemplate}
                      className="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors border border-slate-300"
                    >
                      Baixar Template
                    </button>
                    <button 
                      onClick={deleteGlobalMapping}
                      className="px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors border border-red-200"
                    >
                      Excluir
                    </button>
                    <button 
                      onClick={() => setCurrentStep('mapping')}
                      className="px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 rounded-lg transition-colors border border-indigo-200"
                    >
                      Editar Parametrização
                    </button>
                  </div>
                </div>
              )
            )}
          </div>
        </div>
      )}

      {currentStep === 'mapping' && (
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
                <h2 className="text-xl font-semibold text-slate-800">Mapeamento de Colunas (De-Para)</h2>
                <p className="text-slate-500 text-sm mt-1">
                  Configure como as colunas do seu arquivo serão importadas para o Cargosnap.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <button 
                onClick={deleteGlobalMapping}
                className="bg-white border border-red-200 hover:bg-red-50 text-red-600 px-4 py-2 rounded-xl font-medium transition-colors"
              >
                Excluir Parametrização
              </button>
              <button 
                onClick={saveGlobalMapping}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-colors shadow-sm"
              >
                <CheckCircle size={18} />
                Salvar Parametrização
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 space-y-6">
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 relative">
                <button 
                  className="absolute top-4 right-4 text-slate-400 hover:text-indigo-600"
                  onClick={() => setActiveHelp(activeHelp === 'reference' ? null : 'reference')}
                >
                  <HelpCircle size={18} />
                </button>
                <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-indigo-500"></div>
                  Coluna de Referência
                </h3>
                {activeHelp === 'reference' && (
                  <div className="mb-4 p-3 bg-indigo-50 text-indigo-800 text-sm rounded-lg border border-indigo-100 animate-in fade-in">
                    <p className="font-medium mb-1 flex items-center gap-1"><Info size={14} /> O que é isso?</p>
                    A coluna que contém o identificador único (ex: Container, Placa, Pedido). É obrigatória para criar ou atualizar registros no Cargosnap.
                  </div>
                )}
                <select 
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-3 text-slate-700 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                  value={referenceColumn}
                  onChange={(e) => setReferenceColumn(e.target.value)}
                >
                  <option value="">Selecione a coluna...</option>
                  {rawHeaders.map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </div>

              <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 relative">
                <button 
                  className="absolute top-4 right-4 text-slate-400 hover:text-indigo-600"
                  onClick={() => setActiveHelp(activeHelp === 'location' ? null : 'location')}
                >
                  <HelpCircle size={18} />
                </button>
                <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                  Location (Opcional)
                </h3>
                {activeHelp === 'location' && (
                  <div className="mb-4 p-3 bg-indigo-50 text-indigo-800 text-sm rounded-lg border border-indigo-100 animate-in fade-in">
                    <p className="font-medium mb-1 flex items-center gap-1"><Info size={14} /> Como funciona?</p>
                    Você pode definir um Location ID fixo para todos os registros E/OU selecionar uma coluna da planilha que contém os IDs. Se ambos estiverem preenchidos, o ID Fixo terá prioridade.
                  </div>
                )}
                
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-600 mb-1">ID Fixo</label>
                    <input 
                      type="text" 
                      placeholder="Ex: LOC-123"
                      className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-2.5 text-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                      value={locationId}
                      onChange={(e) => setLocationId(e.target.value)}
                    />
                  </div>
                  
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center" aria-hidden="true">
                      <div className="w-full border-t border-slate-200"></div>
                    </div>
                    <div className="relative flex justify-center">
                      <span className="bg-white px-3 text-xs font-medium text-slate-400 uppercase tracking-wider">E/OU</span>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-600 mb-1">Coluna da Planilha</label>
                    <select 
                      className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-2.5 text-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                      value={locationColumn}
                      onChange={(e) => setLocationColumn(e.target.value)}
                    >
                      <option value="">Selecione a coluna...</option>
                      {rawHeaders.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>

            <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
              <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-amber-500"></div>
                  Mapeamento de Campos
                </h3>
                <span className="text-xs font-medium bg-indigo-100 text-indigo-700 px-2.5 py-1 rounded-full">
                  {rawHeaders.length} colunas encontradas
                </span>
              </div>
              
              <div className="overflow-y-auto max-h-[600px] p-2 custom-scrollbar">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr>
                      <th className="pb-3 pt-2 px-4 font-semibold text-slate-500 text-sm border-b border-slate-200 w-1/2">Coluna na Planilha</th>
                      <th className="pb-3 pt-2 px-4 font-semibold text-slate-500 text-sm border-b border-slate-200 w-1/2">ID do Campo no Cargosnap</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rawHeaders.map((header, idx) => {
                      if (header === referenceColumn || header === locationColumn) return null;
                      
                      return (
                        <tr key={header} className="hover:bg-slate-50 transition-colors group">
                          <td className="py-3 px-4 border-b border-slate-100">
                            <div className="font-medium text-slate-700">{header}</div>
                            {rawData.length > 0 && (
                              <div className="text-xs text-slate-400 mt-1 truncate max-w-[200px]" title={String(rawData[0][header] || '')}>
                                Ex: {String(rawData[0][header] || 'Vazio')}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 border-b border-slate-100">
                            <input 
                              type="text" 
                              placeholder="Ex: field_123"
                              className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all group-hover:border-indigo-300"
                              value={columnMapping[header] || ''}
                              onChange={(e) => handleMappingChange(header, e.target.value)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
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
    </>
  );
}
