'use client';
import { notFound } from 'next/navigation';
import { LECTURES, CHANNEL } from '@/lib/constants';
import { PlaylistColumn } from '@/components/lecture/PlaylistColumn';
import { ChatDrawer }     from '@/components/chat/ChatDrawer';
import { ChatToggleBar }  from '@/components/chat/ChatToggleBar';
import { useChat }        from '@/hooks/useChat';

export default function LecturePage({ params }: { params: { id: string } }) {
  const lecture = LECTURES.find((l) => l.id === params.id);
  if (!lecture) notFound();

  const chat = useChat(lecture.title);

  return (
    <div className="flex overflow-hidden" style={{ height: 'calc(100vh - 56px)' }}>
      {/* ── Left: Video + Info ─────────────────────── */}
      <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 80 }}>
        <div className="p-6">
          {/* Player */}
          <div className="w-full aspect-video rounded-xl overflow-hidden bg-black shadow-lg">
            <iframe
              src={`https://www.youtube.com/embed/${lecture.videoId}?rel=0&modestbranding=1`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="w-full h-full border-0"
            />
          </div>

          {/* Title */}
          <h1 className="text-[20px] font-bold leading-snug mt-4 mb-3">{lecture.title}</h1>

          {/* Actions */}
          <div className="flex gap-2 mb-3 flex-wrap">
            {[
              { icon: 'fas fa-thumbs-up', label: '17', active: true },
              { icon: 'fas fa-thumbs-down', label: '' },
              { icon: 'fas fa-share-nodes', label: 'Share' },
              { icon: 'fas fa-bookmark',    label: 'Save' },
              { icon: 'fas fa-ellipsis',    label: 'More' },
            ].map(({ icon, label, active }) => (
              <button
                key={icon + label}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[13px] font-semibold transition-colors ${
                  active ? 'bg-[var(--text)] text-white' : 'bg-[var(--surface)] hover:bg-gray-200 text-[var(--text)]'
                }`}
              >
                <i className={`${icon} text-[13px]`} />
                {label && <span>{label}</span>}
              </button>
            ))}
          </div>

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
          <div className="bg-[var(--surface)] rounded-xl p-3.5 text-[13px] text-[var(--muted)] leading-relaxed">
            <strong className="text-[var(--text)]">Week {lecture.num + 1} · Generative AI Free Course</strong>
            <br /><br />
            Dr. Adeel Nawab (PhD UK) presents this lecture as part of the free Generative AI Fundamentals course by Fazal Qadir Khan Islamic Institute Pakistan. Watch, then ask the AI Tutor any question about this specific lecture.
          </div>
        </div>
      </div>

      {/* ── Right: Playlist ────────────────────────── */}
      <PlaylistColumn activeLectureId={lecture.id} />

      {/* ── Chat toggle bar ────────────────────────── */}
      {!chat.isOpen && (
        <ChatToggleBar onOpen={chat.toggleChat} lectureNum={lecture.num} />
      )}

      {/* ── Chat drawer ────────────────────────────── */}
      <ChatDrawer
        isOpen={chat.isOpen}
        onClose={chat.toggleChat}
        lectureTitle={lecture.title}
        messages={chat.messages}
        isTyping={chat.isTyping}
        mode={chat.mode}
        onSetMode={chat.setMode}
        onSend={chat.sendMessage}
        isRecording={chat.isRecording}
        onToggleRecord={chat.toggleRecording}
        isSpeaking={chat.isSpeaking}
        onStopSpeaking={chat.stopSpeaking}
        onSpeak={chat.speak}
        interimText={chat.interimText}
      />
    </div>
  );
}
