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
  query RecentQuestions {
    recentQuestions {
      id
      studentName
      studentEmail
      lectureTitle
      question
      createdAt
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
  query StudentJourney($id: String!) {
    studentJourney(id: $id) {
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
    }
  }
`;

export const GET_REGISTERED_STUDENTS = gql`
  query RegisteredStudents {
    registeredStudents {
      id
      name
      email
      createdAt
      questionCount
      status
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
