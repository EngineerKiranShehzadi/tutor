import { gql } from '@apollo/client';

export const GET_ANALYTICS_SUMMARY = gql`
  query AnalyticsSummary {
    analyticsSummary {
      totalStudents
      totalLectures
      totalQuestions
      readyAgents
    }
  }
`;

export const GET_QUESTIONS_PER_LECTURE = gql`
  query QuestionsPerLecture {
    questionsPerLecture {
      lectureId
      lectureTitle
      count
    }
  }
`;

export const GET_RECENT_QUESTIONS = gql`
  query RecentQuestions($limit: Int) {
    recentQuestions(limit: $limit) {
      id
      studentName
      studentEmail
      lectureTitle
      question
      createdAt
    }
  }
`;

// One page of student questions, filtered on the server (A11).
export const GET_RECENT_QUESTIONS_PAGE = gql`
  query RecentQuestionsPage($limit: Int!, $offset: Int!, $search: String, $lectureId: Int) {
    recentQuestionsPage(limit: $limit, offset: $offset, search: $search, lectureId: $lectureId) {
      items {
        id
        studentName
        studentEmail
        lectureId
        lectureTitle
        question
        createdAt
      }
      total
      hasMore
    }
  }
`;

export const GET_LECTURE_STATUS_LIST = gql`
  query LectureStatusList {
    lectureStatusList {
      id
      title
      status
    }
  }
`;

export const GET_STUDENT_JOURNEY = gql`
  query StudentJourney($id: String!, $limit: Int, $offset: Int) {
    studentJourney(id: $id, limit: $limit, offset: $offset) {
      studentId
      studentName
      studentEmail
      status
      questionCount
      lecturesEngaged
      joinedAt
      firstActivity
      lastActivity
      questions {
        id
        question
        lectureTitle
        lectureId
        createdAt
      }
      hasMoreQuestions
      byLecture {
        lectureId
        lectureTitle
        questionCount
        firstAsked
        lastAsked
      }
    }
  }
`;

export const GET_CONTENT_GAPS = gql`
  query ContentGaps {
    contentGaps {
      lectureId
      lectureTitle
      questionsAsked
      chunkCount
      coverageScore
      gapTopics
      coveredTopics
      status
      answeredFromLecture
      notInLecture
      sampled
      chunksSampled
      windowDays
    }
  }
`;

// One page of students, filtered on the server (AD6). The summary counts
// cover every student, so a dashboard can ask for limit 1 and read them.
export const GET_REGISTERED_STUDENTS = gql`
  query RegisteredStudents($limit: Int!, $offset: Int!, $search: String, $status: String) {
    registeredStudents(limit: $limit, offset: $offset, search: $search, status: $status) {
      items {
        id
        name
        email
        createdAt
        questionCount
        status
      }
      total
      hasMore
      totalStudents
      activeCount
      inactiveCount
    }
  }
`;


export const MY_STATS_QUERY = gql`
  query MyStats {
    myStats {
      totalQuestions
      totalSessions
      lecturesEngaged
      totalAvailableLectures
      lastActive
      memberSince
      learningStreak
      mostAskedTopic
      activityBadge
      thisWeekQuestions
      lastWeekQuestions
      weeklyActivity { day date count }
      lectureBreakdown { lectureId lectureTitle count }
      peakHour
    }
  }
`;
