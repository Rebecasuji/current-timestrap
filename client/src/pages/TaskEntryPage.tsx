import React from 'react';
import { useLocation, useParams } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import TaskForm from '@/components/TaskForm';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/ui/card';
import { Loader2, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';
import { Task } from '@/components/TaskTable';

// Parse task description that may contain task and subtask
const parseTaskDescription = (taskDesc: string) => {
  const parts = taskDesc.split(' | ');
  if (parts.length >= 2) {
    return { title: parts[0], subTask: parts[1], description: parts.slice(2).join(' | ') };
  }
  const colonParts = taskDesc.split(':');
  return { title: colonParts[0] || taskDesc, subTask: '', description: colonParts[1]?.trim() || '' };
};

const parseDuration = (duration: string): number => {
  const match = duration.match(/(\d+)h\s*(\d+)m?/);
  if (match) {
    return parseInt(match[1]) * 60 + parseInt(match[2] || '0');
  }
  return 0;
};

export default function TaskEntryPage() {
  const { id } = useParams();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  
  // Get date from URL or use today
  const searchParams = new URLSearchParams(window.location.search);
  const dateParam = searchParams.get('date') || format(new Date(), 'yyyy-MM-dd');

  // Fetch the employee's time entries to find the one we're editing
  const { data: timeEntries = [], isLoading } = useQuery<any[]>({
    queryKey: ['/api/time-entries/employee', user?.id],
    enabled: !!user?.id && !!id,
  });

  const rawTask = id ? timeEntries.find((t) => t.id === id || t.id.toString() === id) : undefined;

  let task: Task | undefined = undefined;
  if (rawTask) {
    const parsed = parseTaskDescription(rawTask.taskDescription);
    task = {
      id: rawTask.id,
      project: rawTask.projectName,
      title: parsed.title,
      subTask: parsed.subTask,
      description: parsed.description,
      problemAndIssues: rawTask.problemAndIssues || '',
      quantify: rawTask.quantify || '',
      achievements: rawTask.achievements || '',
      scopeOfImprovements: rawTask.scopeOfImprovements || '',
      toolsUsed: rawTask.toolsUsed || [],
      startTime: rawTask.startTime,
      endTime: rawTask.endTime,
      durationMinutes: parseDuration(rawTask.totalHours),
      percentageComplete: rawTask.percentageComplete ?? 0,
      pmsId: rawTask.pmsId || undefined,
      pmsSubtaskId: rawTask.pmsSubtaskId || undefined,
      keyStep: rawTask.keyStep || undefined,
    } as Task;
  }

  const handleSave = () => {
    setLocation(`/tracker?date=${dateParam}`);
  };

  const handleCancel = () => {
    setLocation(`/tracker?date=${dateParam}`);
  };

  // If we have an ID but data is still loading
  if (id && isLoading) {
    return (
      <div className="flex h-[calc(100vh-4rem)] items-center justify-center bg-[#0B1120]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B1120] text-white p-6 relative overflow-hidden">
      {/* Background gradients */}
      <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-blue-900/10 via-transparent to-transparent pointer-events-none" />
      
      <div className="max-w-4xl mx-auto relative z-10 pt-4">
        <Button 
          variant="ghost" 
          onClick={handleCancel}
          className="mb-6 text-slate-400 hover:text-white hover:bg-white/5 transition-all"
        >
          <ChevronLeft className="w-4 h-4 mr-2" />
          Back to Tracker
        </Button>

        <Card className="bg-slate-900/60 backdrop-blur-xl border-white/5 p-6 md:p-8 shadow-2xl rounded-2xl">
          <div className="flex items-center justify-between mb-8 pb-4 border-b border-white/5">
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight" style={{ fontFamily: 'Space Grotesk' }}>
                {id ? 'Edit Timesheet Entry' : 'New Timesheet Entry'}
              </h1>
              <p className="text-slate-400 mt-1 text-sm">
                {id ? 'Update your previously logged task details.' : 'Log a new task for your timesheet.'}
              </p>
            </div>
            <div className="px-3 py-1 bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold rounded-full">
              {format(new Date(dateParam), 'EEEE, MMMM d, yyyy')}
            </div>
          </div>
          
          <TaskForm
            task={task as any}
            date={dateParam}
            user={user as any}
            onSave={handleSave}
            onCancel={handleCancel}
            saveButtonText={id ? "Update Entry" : "Save Entry"}
          />
        </Card>
      </div>
    </div>
  );
}
