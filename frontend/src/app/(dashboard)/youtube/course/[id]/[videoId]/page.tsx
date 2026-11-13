'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { ChatInput } from '@/components/chat/ChatInput';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { ChatSidebar, type PersonalChatAdapter, type Session as SidebarSession } from '@/components/chat/ChatSidebar';
import { TypingIndicator } from '@/components/chat/TypingIndicator';
import { TeacherAvatarPanel } from '@/components/avatar/TeacherAvatarPanel';
import { useAvatarSpeech } from '@/hooks/useAvatarSpeech';
import { useVoice } from '@/hooks/useVoice';
import { deriveAvatarState } from '@/lib/avatar/avatar-state';
import type { ChatMessage } from '@/types';

interface Video {video_id:string;title:string;position:number;ingest_status:string}
interface Course {id:string;title:string;channel_title:string;status:string;videos:Video[]}
interface Session {id:string;title:string;video_id:string;updated_at:string}
interface Citation {videoId:string;videoTitle:string;startTime:string;endTime:string;url:string}
interface StoredMessage {id:string;role:'user'|'ai';content:string;sources:Citation[];created_at:string}
interface Props {params:{id:string;videoId:string}}
const base=(id:string)=>'/youtube/my-courses/'+encodeURIComponent(id);
export default function PersonalYoutubeLecturePage({params}:Props) {
  const {id,videoId}=params;
  const [course,setCourse]=useState<Course|null>(null);
  const [loading,setLoading]=useState(true);
  const [sessions,setSessions]=useState<Session[]>([]);
  const [sidebarRefresh,setSidebarRefresh]=useState(0);
  const [sessionId,setSessionId]=useState<string|null>(null);
  const [messages,setMessages]=useState<StoredMessage[]>([]);
  const [input,setInput]=useState('');
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const [showHistory,setShowHistory]=useState(true);
  const [avatarVisible,setAvatarVisible]=useState(true);
  const [recSeconds,setRecSeconds]=useState(0);
  const speech=useAvatarSpeech();
  const voice=useVoice({enabled:true,onTranscriptReady: text=>setInput(old=>(old ? old+' ' : '')+text)});
  const requestVersion=useRef(0);
  const currentRef=useRef<string|null>(null);
  const bottomRef=useRef<HTMLDivElement>(null);
  const playable=course?.videos.find(v=>v.video_id===videoId && v.ingest_status==='READY');
  const refreshSessions=useCallback(async()=>{
    const res=await api.get(base(id)+'/sessions',{params:{videoId}});
    setSessions(res.data.data.sessions??[]);
    setSidebarRefresh(n=>n+1);
    return (res.data.data.sessions??[]) as Session[];
  },[id,videoId]);
  const selectSession=useCallback(async(sid:string)=>{
    requestVersion.current++;
    const epoch=requestVersion.current;
    currentRef.current=sid;
    setSessionId(sid);setMessages([]);setError('');
    speech.stop();voice.stopSpeaking();
    try {
      const res=await api.get(base(id)+'/sessions/'+encodeURIComponent(sid));
      if(requestVersion.current===epoch) setMessages(res.data.data.messages??[]);
    }catch {if(requestVersion.current===epoch)setError('Could not load chat history.');}
  },[id,speech.stop,voice.stopSpeaking]);
  useEffect(()=>{
    let active=true;
    requestVersion.current++;
    setCourse(null);setSessions([]);setSessionId(null);setMessages([]);setLoading(true);setError('');
    (async()=>{
      try {
        const res=await api.get('/youtube/my-courses');
        if(!active)return;
        const found=(res.data.data.courses as Course[]).find(c=>String(c.id)===id);
        if(!found || !found.videos.some(v=>v.video_id===videoId && v.ingest_status==='READY')){
          setError('Lecture is unavailable or not ready.');setLoading(false);return;
        }
        setCourse(found);
        const list=await api.get(base(id)+'/sessions',{params:{videoId}});
        if(!active)return;
        const existing=(list.data.data.sessions??[]) as Session[];
        setSessions(existing);
        if(existing.length){
          const sid=String(existing[0].id);
          currentRef.current=sid;setSessionId(sid);
          const history=await api.get(base(id)+'/sessions/'+encodeURIComponent(sid));
          if(active && currentRef.current===sid) setMessages(history.data.data.messages??[]);
        } else {
          const created=await api.post(base(id)+'/sessions',{videoId});
          if(!active)return;
          const sid=String(created.data.data.session.id);
          currentRef.current=sid;setSessionId(sid);
          await refreshSessions();
        }
      }catch {if(active)setError('Could not open your private YouTube lecture.');}
      finally {if(active)setLoading(false);}
    })();
    return ()=>{active=false;requestVersion.current++;speech.stop();voice.stopSpeaking();};
  // Components own voice controllers; do not recreate the page on chat state updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[id,videoId]);
  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:'smooth',block:'end'});},[messages,pending]);
  useEffect(()=>{
    if(!voice.isListening){setRecSeconds(0);return;}
    const timer=window.setInterval(()=>setRecSeconds(s=>s+1),1000);
    return ()=>window.clearInterval(timer);
  },[voice.isListening]);
  const newChat=async()=>{
    if(pending)return;
    requestVersion.current++;
    setMessages([]);setError('');speech.stop();
    try {
      const res=await api.post(base(id)+'/sessions',{videoId});
      const sid=String(res.data.data.session.id);
      currentRef.current=sid;setSessionId(sid);
      await refreshSessions();
    }catch {setError('Could not create chat.');}
  };
  const ask=async(text:string)=>{
    const sid=currentRef.current;
    if(!sid||pending||text.trim().length<3||text.length>500)return;
    const epoch=requestVersion.current;
    const ownMessage:StoredMessage={id:'draft-'+Date.now(),role:'user',content:text,sources:[],created_at:new Date().toISOString()};
    setMessages(m=>[...m,ownMessage]);setPending(true);setError('');
    try {
      const response=await api.post(base(id)+'/sessions/'+encodeURIComponent(sid)+'/ask',{question:text});
      if(requestVersion.current!==epoch)return;
      const answer=response.data.data as {answer:string;sources:Citation[]};
      setMessages(m=>[...m,{id:'answer-'+Date.now(),role:'ai',content:answer.answer,sources:answer.sources,created_at:new Date().toISOString()}]);
      await refreshSessions();
    }catch(e:any){
      if(requestVersion.current===epoch){
        setMessages(m=>m.filter(x=>x.id!==ownMessage.id));
        setError(e?.response?.data?.message||'The tutor could not answer. Please try again.');
      }
    }finally {if(requestVersion.current===epoch)setPending(false);}
  };
  // The existing ChatSidebar is used unchanged visually; this scoped adapter
  // routes all session operations to owner-checked YouTube REST APIs.
  const personalAdapter=useMemo<PersonalChatAdapter>(()=>({
    list:async()=>{
      const response=await api.get(base(id)+'/sessions',{params:{videoId}});
      return (response.data.data.sessions as Session[]).map((s):SidebarSession=>({
        id:Number(s.id),title:s.title,firstQuestion:null,messageCount:0,
        createdAt:s.updated_at,updatedAt:s.updated_at,
      }));
    },
    rename:async(sid,title)=>{await api.patch(base(id)+'/sessions/'+sid,{title});},
    delete:async(sid)=>{
      await api.delete(base(id)+'/sessions/'+sid);
      if(currentRef.current===String(sid)){
        requestVersion.current++;
        currentRef.current=null;setSessionId(null);setMessages([]);
      }
    },
  }),[id,videoId]);
  const lastAnswer=[...messages].reverse().find(m=>m.role==='ai')?.content||'';
  const avatarState=deriveAvatarState({isAnswerPending:pending,isSpeaking:speech.isSpeaking&&!speech.isPaused,isUserInputActive:!!input||voice.isListening,hasError:!!error});
  if(loading)return <div className="p-10">Loading private lecture…</div>;
  if(!course||!playable)return <div className="p-8"><Link href="/courses" className="underline">Back to courses</Link><p role="alert" className="mt-4">{error||'Lecture not found'}</p></div>;
  return <div className="px-4 py-5 flex gap-5 items-start">
    <div className="w-[55%] shrink-0 overflow-y-auto" style={{maxHeight:'calc(100vh - 100px)'}}>
      <Link href="/courses" className="text-label underline">← Courses</Link>
      <div className="relative w-full aspect-video rounded-card overflow-hidden bg-black shadow-md mt-3">
        <iframe key={videoId} src={'https://www.youtube-nocookie.com/embed/'+videoId+'?rel=0'}
          title={playable.title} allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen className="w-full h-full border-0"/>
      </div>
      <h1 className="text-[22px] font-bold mt-4">{playable.title}</h1>
      <p className="text-label text-[var(--muted)] mt-1">{course.channel_title} · {course.title}</p>
      <h2 className="font-bold mt-6 mb-2">Course Lectures ({course.videos.filter(v=>v.ingest_status==='READY').length})</h2>
      <div className="flex flex-col gap-2">
        {course.videos.filter(v=>v.ingest_status==='READY').sort((a,b)=>a.position-b.position).map(v=>
          <Link key={v.video_id} href={`/youtube/course/${id}/${v.video_id}`}
            className={'flex gap-3 p-2 rounded-card border '+(v.video_id===videoId?'bg-[var(--accent-soft)]':'bg-white hover:bg-[var(--surface)]')}>
            <img src={'https://i.ytimg.com/vi/'+v.video_id+'/hqdefault.jpg'} alt="" className="w-[90px] aspect-video object-cover rounded-control"/>
            <span className="text-label">{v.position}. {v.title}</span>
          </Link>
        )}
      </div>
    </div>
    <div className="flex-1 min-w-0 flex rounded-card border border-[var(--border)] bg-white shadow-md overflow-hidden" style={{height:'calc(100vh - 100px)'}}>
      <div className="flex-1 min-w-0 flex flex-col">
        {avatarVisible ? <TeacherAvatarPanel compact agentName="AskAI Tutor" lectureTitle={playable.title}
          state={avatarState} getMouth={speech.getMouth} speechSupported={speech.supported}
          isSpeaking={speech.isSpeaking} isPaused={speech.isPaused} muted={speech.muted}
          canReplay={!!lastAnswer} errorMessage={speech.error}
          onPlay={()=>{if(speech.muted)speech.toggleMute();if(lastAnswer)speech.speak(lastAnswer);}}
          onPause={speech.pause} onResume={speech.resume} onStop={speech.stop}
          onToggleMute={speech.toggleMute} onHide={()=>setAvatarVisible(false)}/> :
          <button type="button" className="p-3 text-label underline" onClick={()=>setAvatarVisible(true)}>Show AI Teacher</button>}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
          <p className="text-center text-caption text-[var(--accent)]">Agent ready — scoped to this lecture only</p>
          {error && <p role="alert" className="text-red-600 text-label">{error}</p>}
          {messages.map(m=><div key={m.id}>
            <MessageBubble message={{id:m.id,role:m.role,type:'text',content:m.content,timestamp:new Date(m.created_at)}} onSpeak={m.role==='ai'?speech.speak:undefined}/>
            {m.role==='ai' && m.sources?.length>0 &&
              <div className="ml-12 mt-2 text-caption"><strong>Video citations</strong>
                {m.sources.map((s,i)=><a className="block underline text-[var(--accent)] mt-1" target="_blank"
                  rel="noopener noreferrer" key={i} href={s.url}>{s.videoTitle} · {s.startTime}–{s.endTime}</a>)}
              </div>}
          </div>)}
          {pending&&<TypingIndicator/>}<div ref={bottomRef}/>
        </div>
        <ChatInput value={input} onChange={setInput} onSend={text=>void ask(text)}
          isRecording={voice.isListening} onToggleRecord={voice.toggleListening}
          interimText={voice.interimText} isSpeechSupported={voice.isSupported.stt}
          recSeconds={recSeconds} isAnswerPending={pending}
          voiceError={voice.error} onDismissVoiceError={voice.clearError}/>
      </div>
      {showHistory && <ChatSidebar
        lectureId={-(Number(id)*4+playable.position)}
        activeSessionId={sessionId?Number(sessionId):null}
        refreshKey={sidebarRefresh}
        onNewChat={()=>void newChat()}
        onSelectSession={sid=>{if(!pending)void selectSession(String(sid));}}
        onClose={()=>setShowHistory(false)}
        personalAdapter={personalAdapter}
      />}
      {!showHistory&&<button type="button" className="p-2 self-start" onClick={()=>setShowHistory(true)} aria-label="Show chat history">☰</button>}
    </div>
  </div>;
}
