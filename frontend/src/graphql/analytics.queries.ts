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

export const GET_REGISTERED_STUDENTS = gql`
  query RegisteredStudents {
    registeredStudents {
      id
      name
      email
      createdAt
    }
  }
`;
