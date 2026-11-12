'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useQuery } from '@apollo/client';
import { GET_COURSES } from '@/graphql/course.queries';
import { GET_LECTURES } from '@/graphql/lecture.queries';
import type { DBCourse } from '@/types/course';
import type { DBLecture } from '@/types';
import { sortLectures, statusBadge, isLectureReady } from '@/lib/lectures';

function LoadingLectures() {
  return <div role="status" aria-label="Loading lectures" className="px-6 py-8"><div className="h-8 w-56 rounded-control bg-[var(--surface)] animate-pulse"/><div className="mt-5 h-64 rounded-card border border-[var(--border)] bg-white animate-pulse"/></div>;
}
function LectureList() {
  const params=useSearchParams();
  const filterId=params.get('courseId');
  const {data,loading,error,refetch}=useQuery(GET_LECTURES,{fetchPolicy:'cache-and-network'});
  const {data:courseData}=useQuery(GET_COURSES,{fetchPolicy:'cache-and-network'});
  const lectures:DBLecture[]=data?.lectures??[];
  if(loading&&!data)return <LoadingLectures/>;
  if(error&&!data)return <div role="alert" className="px-6 py-8 text-red-600">Failed to load lectures. <button className="underline" onClick={()=>void refetch().catch(()=>undefined)}>Try again</button></div>;
  const selectedCourse:DBCourse|undefined=(courseData?.courses??[]).find((c:DBCourse)=>String(c.id)===filterId);
  const ordered=sortLectures(filterId?lectures.filter(l=>String(l.courseId)===filterId):lectures);
  const firstReady=ordered.find(l=>isLectureReady(l.status));
  const featured=ordered.find(l=>l.youtubeVideoId);
  return <div className="px-6 py-8">
    {selectedCourse&&<p className="mb-4 text-label text-[var(--muted)]"><Link href="/courses" className="hover:text-[var(--accent)]">All Courses</Link> / {selectedCourse.title}</p>}
    {error&&data&&<p role="status" className="mb-4 text-caption text-[var(--muted)]">Showing previously loaded lectures. <button className="underline" onClick={()=>void refetch().catch(()=>undefined)}>Retry refresh</button></p>}
    <div className="flex gap-5 items-start">
      <div className="w-[55%] shrink-0">
        <div className="relative w-full aspect-video rounded-card overflow-hidden bg-black shadow-md">
          {featured?.youtubeVideoId?<iframe src={`https://www.youtube.com/embed/${featured.youtubeVideoId}?rel=0&modestbranding=1`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen className="w-full h-full border-0" title={featured.title}/>:<div className="w-full h-full flex flex-col items-center justify-center text-white/60 gap-2"><i className="fas fa-video-slash text-3xl"/><p className="text-sm">No video available yet</p></div>}
        </div>
        {featured&&<p className="mt-3 text-h3 font-semibold text-[var(--text)] leading-snug">{featured.title}</p>}
      </div>
      <div className="flex-1 min-w-0 bg-white rounded-card border border-[var(--border)] shadow-md flex flex-col overflow-hidden">
        <div className="px-4 py-4 border-b border-[var(--border)]"><div className="flex items-center justify-between">
          <div><h1 className="text-h2 font-semibold text-[var(--text)]">{selectedCourse?selectedCourse.title:'All Lectures'}</h1><p className="text-label text-[var(--muted)] mt-1">{ordered.length} lecture{ordered.length!==1?'s':''} available</p></div>
          {firstReady&&<Link href={`/lecture/${firstReady.id}`} className="flex items-center gap-2 h-10 px-5 bg-[var(--accent)] hover:bg-[var(--accent-deep)] text-white rounded-control text-label font-semibold transition-colors shrink-0"><i className="fas fa-play text-[10px]"/>Start Learning</Link>}
        </div></div>
        <div>{ordered.length===0?<div className="text-center py-16 text-[var(--muted)]"><i className="fas fa-video-slash text-3xl mb-3 block"/><p className="text-sm font-semibold">No lectures yet</p><p className="text-xs mt-1">Check back soon.</p></div>:ordered.map(lec=>{
          const badge=statusBadge(lec.status),ready=isLectureReady(lec.status);
          const contents=<>
            {lec.youtubeVideoId?<div className="w-[78px] shrink-0 aspect-video rounded-control overflow-hidden bg-black border border-[var(--border)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img loading="lazy" src={`https://i.ytimg.com/vi/${lec.youtubeVideoId}/hqdefault.jpg`} alt={lec.title} className="w-full h-full object-cover saturate-[.7] opacity-90 transition duration-200 group-hover:saturate-100 group-hover:opacity-100"/>
            </div>:<div className="w-[78px] shrink-0 aspect-video rounded-control bg-[var(--surface)] border border-[var(--border)] flex items-center justify-center"><i className="fas fa-play-circle text-lg text-[var(--muted)]"/></div>}
            <div className="flex-1 min-w-0"><p className="text-label font-semibold leading-snug line-clamp-2 mb-2 text-[var(--text)]">{lec.title}</p>{!ready&&<span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-caption font-medium ${badge.color}`}><i className="fas fa-clock text-[9px]"/>{badge.label}</span>}</div>
            {ready&&<i className="fas fa-chevron-right text-[var(--muted)] text-[11px] shrink-0 self-center"/>}
          </>;
          const style='group flex gap-3 px-4 py-3 border-b border-[var(--border)] transition-colors ';
          return ready?<Link key={lec.id} href={`/lecture/${lec.id}`} className={style+'cursor-pointer hover:bg-[var(--surface)]'}>{contents}</Link>:<div key={lec.id} aria-disabled="true" className={style+'opacity-60 cursor-default'}>{contents}</div>;
        })}</div>
      </div>
    </div>
  </div>;
}
export default function LecturesPage(){return <Suspense fallback={<LoadingLectures/>}><LectureList/></Suspense>;}
