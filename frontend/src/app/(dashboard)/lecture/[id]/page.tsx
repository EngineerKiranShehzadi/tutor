'use client';
import { notFound, useRouter } from 'next/navigation';
import { useQuery } from '@apollo/client';
import { GET_LECTURES, GET_LECTURE } from '@/graphql/lecture.queries';
import { DBLecture } from '@/types';
import { ChatDrawer }    from '@/components/chat/ChatDrawer';
import { ChatToggleBar } from '@/components/chat/ChatToggleBar';
import { useChat }       from '@/hooks/useChat';
import { cn }            from '@/lib/cn';

const CHANNEL = {
  name:        'Fazal Qadir Khan Islamic Institute Pakistan',
  initials:    'FQ',
  subscribers: '3.05K',
};

interface Props { params: { id: string } }

export default function LecturePage({ params }: Props) {
  const router = useRouter();
  const lectureId = parseInt(params.id, 10);

  const { data: lectureData, loading: lectureLoading } = useQuery(GET_LECTURE, {
    variables: { id: params.id },
    skip: isNaN(lectureId),
  });

  const { data: allData, loading: allLoading } = useQuery(GET_LECTURES);

  const lecture: DBLecture | undefined = lectureData?.lecture;
  const allLectures: DBLecture[] = allData?.lectures ?? [];

  const chat = useChat(
    lecture?.title ?? 'this lecture',
    lectureId,
    `AI Tutor`
  );

  if (lectureLoading || allLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!lecture || isNaN(lectureId)) notFound();

  const isReady = lecture.status === 'READY';

  return (
    <div className="flex overflow-hidden" style={{ height: 'calc(100vh - 56px)' }}>
      {/* ── Left: Video + Info ─────────────────────── */}
      <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 80 }}>
        <div className="p-6">
          {/* Player */}
          <div className="w-full aspect-video rounded-xl overflow-hidden bg-black shadow-lg">
            {lecture.youtubeVideoId ? (
              <iframe
                src={`https://www.youtube.com/embed/${lecture.youtubeVideoId}?rel=0&modestbranding=1`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="w-full h-full border-0"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-white">
                <i className="fas fa-video-slash text-4xl" />
              </div>
            )}
          </div>

          {/* Title */}
          <h1 className="text-[20px] font-bold leading-snug mt-4 mb-3">{lecture.title}</h1>

          {/* AI Status badge */}
          {!isReady && (
            <div className="mb-3 flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5">
              <i className="fas fa-clock text-amber-500" />
              <span className="text-sm text-amber-700 font-medium">
                AI Tutor not yet available for this lecture (status: {lecture.status}).
              </span>
            </div>
          )}

          {/* Channel */}
          <div className="flex items-center gap-3 py-3 border-t border-b border-[var(--border)] mb-3">
            <div className="w-10 h-10 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-bold shrink-0">
              {CHANNEL.initials}
            </div>
            <div className="flex-1">
              <p className="text-[15px] font-bold">{CHANNEL.name}</p>
              <p className="text-[12px] text-[var(--muted)]">{CHANNEL.subscribers} subscribers</p>
            </div>
            <button className="px-4 py-2 bg-[var(--text)] text-white rounded-full text-[13px] font-bold hover:bg-gray-800 transition-colors">
              Subscribe
            </button>
          </div>

          {/* Description */}
          {lecture.description && (
            <div className="bg-[var(--surface)] rounded-xl p-3.5 text-[13px] text-[var(--muted)] leading-relaxed">
              {lecture.description}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: Playlist ────────────────────────── */}
      <div className="w-[340px] shrink-0 border-l border-[var(--border)] flex flex-col overflow-hidden">
        <div className="px-4 py-3.5 border-b border-[var(--border)] shrink-0">
          <p className="text-[14px] font-bold truncate">Course Lectures</p>
          <p className="text-[12px] text-[var(--muted)] mt-0.5">{allLectures.length} total</p>
        </div>
        <div className="flex-1 overflow-y-auto py-2 px-1">
          {allLectures.map((lec, i) => {
            const isActive = lec.id === params.id;
            return (
              <div
                key={lec.id}
                onClick={() => lec.status === 'READY' && router.push(`/lecture/${lec.id}`)}
                className={cn(
                  'flex gap-2.5 p-2 rounded-lg mb-0.5 transition-colors',
                  isActive ? 'bg-blue-50' : lec.status === 'READY' ? 'hover:bg-[var(--surface)] cursor-pointer' : 'opacity-60 cursor-default'
                )}
              >
                <div className="w-5 flex items-start justify-center pt-1 shrink-0">
                  {isActive
                    ? <i className="fas fa-play text-[10px] text-[var(--red)]" />
                    : <span className="text-[12px] text-[var(--muted)]">{i + 1}</span>
                  }
                </div>
                <div className="relative w-[80px] shrink-0 aspect-video rounded-md overflow-hidden bg-black">
                  {lec.youtubeVideoId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`https://i.ytimg.com/vi/${lec.youtubeVideoId}/hqdefault.jpg`}
                      alt={lec.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <i className="fas fa-play-circle text-white/50 text-lg" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={cn('text-[12px] font-semibold line-clamp-2 leading-snug', isActive && 'text-[var(--accent)]')}>
                    {lec.title}
                  </p>
                  <p className="text-[10px] text-[var(--muted)] mt-0.5">
                    {lec.status === 'READY' ? '🟢 AI Ready' : '⏳ Preparing'}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Chat toggle bar ────────────────────────── */}
      {!chat.isOpen && isReady && (
        <ChatToggleBar onOpen={chat.toggleChat} lectureTitle={lecture.title} />
      )}

      {/* ── Chat drawer ────────────────────────────── */}
      {isReady && (
        <ChatDrawer
          isOpen={chat.isOpen}
          onClose={chat.toggleChat}
          lectureTitle={lecture.title}
          agentName={chat.agentName}
          messages={chat.messages}
          isTyping={chat.isTyping}
          isLoadingHistory={chat.isLoadingHistory}
          mode={chat.mode}
          onSetMode={chat.setMode}
          onSend={chat.sendMessage}
          onClearChat={chat.clearChat}
          isRecording={chat.isRecording}
          onToggleRecord={chat.toggleRecording}
          isSpeaking={chat.isSpeaking}
          onStopSpeaking={chat.stopSpeaking}
          onSpeak={chat.speak}
          interimText={chat.interimText}
          isSpeechSupported={chat.isSpeechSupported}
        />
      )}
    </div>
  );
}
